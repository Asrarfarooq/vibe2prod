/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import path from 'node:path'
import { type Request, type Response, type NextFunction } from 'express'

export function serveQuarantineFiles () {
  return ({ params, query }: Request, res: Response, next: NextFunction) => {
    const file = params.file

    if (!file.includes('/') && !file.includes('\\') && !file.includes('..')) {
      const resolved = path.resolve('ftp/quarantine/', file)
      if (resolved.startsWith(path.resolve('ftp/quarantine'))) {
        res.sendFile(resolved)
        return
      }
    }
    res.status(403)
    next(new Error('Access forbidden!'))
  }
}
