/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import { type Request, type Response } from 'express'
import { AddressModel } from '../models/address'

export function getAddress () {
  return async (req: Request, res: Response) => {
    const UserId = Number(req.body.UserId)
    const addresses = await AddressModel.findAll({ where: { UserId } })
    res.status(200).json({ status: 'success', data: addresses })
  }
}

export function getAddressById () {
  return async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const UserId = Number(req.body.UserId)
    if (isNaN(id) || isNaN(UserId)) {
      return res.status(400).json({ status: 'error', data: 'Malicious activity detected.' })
    }
    const address = await AddressModel.findOne({ where: { id, UserId } })
    if (address != null) {
      res.status(200).json({ status: 'success', data: address })
    } else {
      res.status(400).json({ status: 'error', data: 'Malicious activity detected.' })
    }
  }
}

export function delAddressById () {
  return async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const UserId = Number(req.body.UserId)
    if (isNaN(id) || isNaN(UserId)) {
      return res.status(400).json({ status: 'error', data: 'Malicious activity detected.' })
    }
    const address = await AddressModel.destroy({ where: { id, UserId } })
    if (address) {
      res.status(200).json({ status: 'success', data: 'Address deleted successfully.' })
    } else {
      res.status(400).json({ status: 'error', data: 'Malicious activity detected.' })
    }
  }
}
