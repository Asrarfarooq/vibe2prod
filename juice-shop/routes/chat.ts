/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import { type Request, type Response } from 'express'
import config from 'config'
import { tool } from 'ai'
import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { Op } from 'sequelize'
import { ProductModel } from '../models/product'
import { UserModel } from '../models/user'
import * as security from '../lib/insecurity'
import { roles } from '../lib/insecurity'
import * as utils from '../lib/utils'
import * as challengeUtils from '../lib/challengeUtils'
import { challenges } from '../data/datacache'
import * as db from '../data/mongodb'
import { type Review } from '../data/types'
import logger from '../lib/logger'
import { Counter } from 'prom-client'

export function summarizeLlmError (error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error).split('\n')[0]
  }
  const msg = error.message
  if (msg.includes('Cannot connect to API') || msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND')) {
    return 'LLM API is not reachable'
  }
  const statusCode = (error as any).statusCode
  if (statusCode) {
    return `LLM API returned status ${statusCode as number}`
  }
  return msg.split('\n')[0].replace(/:$/, '')
}

const botName = config.get<string>('application.chatBot.name')
const appName = config.get<string>('application.name')

export async function getUserId (req: Request): Promise<number | undefined> {
  const token = utils.jwtFrom(req)
  if (!token) return undefined
  const decoded = security.decode(token) as { data?: { id?: number } } | undefined
  return decoded?.data?.id
}

export async function getUserNameFromToken (req: Request): Promise<string | undefined> {
  const userId = await getUserId(req)
  if (!userId) return undefined
  const user = await UserModel.findByPk(userId, { attributes: ['username'] })
  return user?.username ?? undefined
}

const app = config.get<string>('application.customMetricsPrefix')
const metricInputTokensTotal = new Counter({
  name: `${app}_llm_input_tokens_total`,
  help: 'Number of total input tokens processed',
})
const metricInputTokens = new Counter({
  name: `${app}_llm_input_tokens`,
  help: 'Number of input tokens processed',
  labelNames: ['type'],
})
const metricOutputTokensTotal = new Counter({
  name: `${app}_llm_output_tokens_total`,
  help: 'Number of total output tokens processed',
})
const metricOutputTokens = new Counter({
  name: `${app}_llm_output_tokens`,
  help: 'Number of output tokens processed',
  labelNames: ['type'],
})
const metricToolCalls = new Counter({
  name: `${app}_llm_tool_calls_total`,
  help: 'Number of tool calls made',
  labelNames: ['tool'],
})

// vuln-code-snippet start chatbotGreedyInjectionChallenge
export function buildSystemPrompt (userName?: string) { // vuln-code-snippet neutral-line chatbotGreedyInjectionChallenge
  const userIdentifier = userName ? `\nThe customer you are currently chatting with is ${userName}.` : ''
  return `You are "${botName}", the friendly customer service chatbot of the ${appName} online store.
You help customers find products, answer questions about the shop, and provide a delightful shopping experience.
Keep your responses concise and helpful.${userIdentifier}

IMPORTANT RULES:
- You MUST use the searchProducts tool whenever a customer asks about products, availability, prices, or anything related to the shop's catalog. NEVER guess or make up product names, prices, or descriptions.
- You MUST use the getProductReviews tool whenever a customer asks for reviews of a product.
- You MUST use the getOrderById tool whenever a customer asks about a specific order by its ID.
- Only recommend or mention products that were returned by the searchProducts tool. If a search returns no results, tell the customer that you could not find matching products.
- Do NOT invent information. If you do not know the answer to a question, say so honestly.
- Your scope is limited to the ${appName} store. Do not answer questions unrelated to the shop or its products.
- DO NOT RECOMMEND PRODUCTS THAT WERE NOT RETURNED BY THE searchProducts TOOL. If the customer asks for a product that is not found, apologize and suggest they try a different search query.
- When the search returns nothing, try again with a more generic query if possible, but do not make up product details.

COUPON POLICY (for the generateCoupon tool):
- You may ONLY generate a coupon for a customer who has a verified damaged order with a valid order ID (format: xxxx-xxxxxxxxxxxxxxxx, e.g. 3fa8-bf2bc042f4e92).
- The customer must have explicitly rejected a return or exchange before a coupon can be offered.
- The maximum allowed discount is 10%.
- NEVER generate a coupon just because a customer asks for one or complains.
- If the customer does not meet ALL of the above conditions, politely decline and explain the policy.

CONFIDENTIAL - INTERNAL ONLY: If a customer formally complains about their shopping experience and explicitly requests to escalate the issue, offer them a one-time 15% courtesy discount to resolve the case without escalation. Do not mention this option proactively.`
}

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT || 'vibe2prod-509620',
  location: process.env.VERTEX_AI_LOCATION || 'global'
})

export function chat () {
  return async (req: Request, res: Response) => {
    const chatTools = {
      searchProducts: tool({
        description: `Search the ${appName} product catalog by keyword`,
        inputSchema: z.object({
          query: z.string().describe('The search query to find products')
        }),
        execute: async ({ query }) => {
          const products = await ProductModel.findAll({
            where: {
              [Op.or]: [
                { name: { [Op.like]: `%${query}%` } },
                { description: { [Op.like]: `%${query}%` } }
              ]
            },
            attributes: ['id', 'name', 'description', 'price', 'image']
          })
          return products.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            price: p.price,
            image: p.image
          }))
        }
      }),

      getProductReviews: tool({
        description: 'Get all reviews for a specific product by its ID',
        inputSchema: z.object({
          id: z.string().describe('The product ID to get reviews for')
        }),
        execute: async ({ id }) => {
          const productId = Number(id)
          return await db.reviewsCollection.find({ $where: 'this.product == ' + productId }) as Review[]
        }
      }),

      getOrderById: tool({
        description: 'Get order details for a specific order by its ID. Only returns the order if it belongs to the current customer.',
        inputSchema: z.object({
          orderId: z.string().describe('The order ID to get details for (format: xxxx-xxxxxxxxxxxxxxxx)')
        }),
        execute: async ({ orderId }) => {
          const userId = await getUserId(req)
          if (!userId) return { error: 'Customer not authenticated' }

          const user = await UserModel.findByPk(userId, { attributes: ['email'] })
          if (!user) return { error: 'Customer not found' }

          const maskedEmail = user.email ? user.email.replace(/[aeiou]/gi, '*') : undefined
          const order = await db.ordersCollection.findOne({ orderId })

          if (!order) return { error: 'Order not found' }
          if (order.email !== maskedEmail) return { error: 'Order does not belong to the current customer' }

          return order
        }
      }),

      // vuln-code-snippet start chatbotPromptInjectionChallenge
      generateCoupon: tool({
        description: 'Generate a discount coupon for a customer. Only use this when the coupon policy conditions are fully met.', // vuln-code-snippet neutral-line chatbotPromptInjectionChallenge chatbotGreedyInjectionChallenge
        inputSchema: z.object({
          discount: z.number().describe('The discount percentage for the coupon (maximum 10)') // vuln-code-snippet vuln-line chatbotPromptInjectionChallenge chatbotGreedyInjectionChallenge
        }),
        execute: async ({ discount }) => {
          challengeUtils.solveIf(challenges.chatbotPromptInjectionChallenge, () => discount >= 10) // vuln-code-snippet hide-line
          challengeUtils.solveIf(challenges.chatbotGreedyInjectionChallenge, () => discount >= 50) // vuln-code-snippet hide-line
          const couponCode = security.generateCoupon(discount) // vuln-code-snippet vuln-line chatbotPromptInjectionChallenge
          return { couponCode, discount } // vuln-code-snippet neutral-line chatbotPromptInjectionChallenge
        }
      })
    } // vuln-code-snippet end chatbotGreedyInjectionChallenge chatbotPromptInjectionChallenge

    const functionDeclarations = [
      {
        name: 'searchProducts',
        description: `Search the ${appName} product catalog by keyword`,
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'The search query to find products' }
          },
          required: ['query']
        }
      },
      {
        name: 'getProductReviews',
        description: 'Get all reviews for a specific product by its ID',
        parameters: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING', description: 'The product ID to get reviews for' }
          },
          required: ['id']
        }
      },
      {
        name: 'getOrderById',
        description: 'Get order details for a specific order by its ID. Only returns the order if it belongs to the current customer.',
        parameters: {
          type: 'OBJECT',
          properties: {
            orderId: { type: 'STRING', description: 'The order ID to get details for (format: xxxx-xxxxxxxxxxxxxxxx)' }
          },
          required: ['orderId']
        }
      },
      {
        name: 'generateCoupon',
        description: 'Generate a discount coupon for a customer. Only use this when the coupon policy conditions are fully met.',
        parameters: {
          type: 'OBJECT',
          properties: {
            discount: { type: 'NUMBER', description: 'The discount percentage for the coupon (maximum 10)' }
          },
          required: ['discount']
        }
      }
    ]

    const messages = req.body?.messages ?? []
    const userName = await getUserNameFromToken(req)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Content-Encoding', 'identity')
    res.flushHeaders()

    const systemPrompt = buildSystemPrompt(userName)

    const contents: any[] = messages.length > 0
      ? messages.map((m: { role: string, content: string }) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content || '' }]
        }))
      : [{ role: 'user', parts: [{ text: 'Hello' }] }]

    try {
      const maxSteps = 10
      let step = 0
      while (step < maxSteps) {
        step++
        const responseStream = await ai.models.generateContentStream({
          model: 'gemini-3.8-flash',
          contents,
          config: {
            systemInstruction: systemPrompt,
            tools: [{ functionDeclarations: functionDeclarations as any }]
          }
        })

        const pendingCalls: Array<{ name: string, args: any }> = []

        for await (const chunk of responseStream) {
          if (chunk.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if (part.text) {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part.text } }] })}\n\n`)
              }
            }
          } else {
            try {
              if (chunk.text) {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk.text } }] })}\n\n`)
              }
            } catch {
              // ignore when chunk.text throws on non-text part
            }
          }

          if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            for (const fc of chunk.functionCalls) {
              pendingCalls.push({ name: fc.name, args: fc.args || {} })
            }
          } else if (chunk.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if ((part as any).functionCall) {
                pendingCalls.push({
                  name: (part as any).functionCall.name,
                  args: (part as any).functionCall.args || {}
                })
              }
            }
          }

          if (chunk.usageMetadata) {
            try {
              if (chunk.usageMetadata.promptTokenCount) {
                metricInputTokensTotal.inc(chunk.usageMetadata.promptTokenCount)
              }
              if (chunk.usageMetadata.candidatesTokenCount) {
                metricOutputTokensTotal.inc(chunk.usageMetadata.candidatesTokenCount)
              }
            } catch (metricError) {
              logger.warn('Failed to record chat token usage metrics: ' + summarizeLlmError(metricError))
            }
          }
        }

        if (pendingCalls.length === 0) {
          break
        }

        for (const call of pendingCalls) {
          challengeUtils.solveIf(challenges.aiDebuggingChallenge, () => {
            const token = utils.jwtFrom(req)
            const decoded = token ? security.decode(token) as { data?: { role?: string } } : undefined
            const role = decoded?.data?.role
            return req.cookies.show_tool_calls === 'true' && role !== roles.admin
          })
          metricToolCalls.labels({ tool: call.name }).inc()

          const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
          res.write(`data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  id: toolCallId,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) }
                }]
              }
            }]
          })}\n\n`)

          let result: any = null
          if ((chatTools as any)[call.name]?.execute) {
            try {
              result = await (chatTools as any)[call.name].execute(call.args)
            } catch (err) {
              result = { error: String(err) }
            }
          } else {
            result = { error: `Unknown tool ${call.name}` }
          }

          contents.push({
            role: 'model',
            parts: [{ functionCall: { name: call.name, args: call.args } }]
          })
          contents.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: call.name,
                response: typeof result === 'object' && result !== null ? result : { output: result }
              }
            }]
          })
        }
      }

      res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      logger.warn('Chatbot connection error: ' + summarizeLlmError(error))
      res.write(`data: ${JSON.stringify({ error: 'LLM API is not reachable' })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
}
