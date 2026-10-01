/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import path from 'node:path'
import { type Request, type Response, type NextFunction } from 'express'

export function serveLogFiles () {
  return ({ params }: Request, res: Response, next: NextFunction) => {
    const file = params.file

    if (!file.includes('/') && !file.includes('\\') && !file.includes('..')) {
      const resolved = path.resolve('logs/', file)
      if (resolved.startsWith(path.resolve('logs'))) {
        res.sendFile(resolved)
        return
      }
    }
    res.status(403)
    next(new Error('Access forbidden!'))
  }
}
