<p align="center">
    <img height="200" src="https://raw.githubusercontent.com/gallolabs/logger/main/logo_w200.jpeg">
  <p align="center"><strong>Gallo logger</strong></p>
</p>

Simple logger:
- [x] log -> processors -> obfuscation -> handlers (own processors + format + transport)
- [x] Advanced childs (not only id and metadata but also own processors and handlers stack), siblings, and extends
- [x] Default simple JSON console logging
- [x] logfmt formatter available
- [x] BreadCrumb handler (like Monolog Fingers crossed handler) : keep some verbose logs in memory until an error-like log is logged. Kept verbose logs are flushed with it. Verbose logs are kept on a logger chain (parent/child) to flush only (as possible) relevant logs.
- [x] Error handler
- [x] Idle wait method

```typescript

const logger = createLogger({...})

// loggerId can be any type
const child = logger.child({ component: 'http-server', alias: 'public-server' })
const child = logger.child('public-server', {child: true})

child.info('My log', {password: 'secret'})

// Will log {level: 'info', message: 'My log', password: '***', child: true, timestamp: '(date)', logger: 'public-server'}

```