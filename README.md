# Logger

Simple logger:
- log -> processors -> obfuscation -> handlers (own processors + format + transport)
- Advanced childs (not only id and metadata but also own processors and handlers stack), siblings, and extends
- Default simple JSON console logging
- logfmt formatter available
- X No more Secrets Obfuscation
- BreadCrumb handler (like Monolog Fingers crossed handler) : keep some verbose logs in memory until an error-like log is logged. Kept verbose logs are flushed with it. Verbose logs are kept on a logger chain (parent/child) to flush only (as possible) relevant logs.
- [ ] Add handlers filter or filter handler ?
- [ ] Improve async handlers : abort on them, listen to finish distribution, error handling or let error go back up ? remove logging method async because does make it sense to be able to wait for one log to be distributed ? Logging is a task (await logger.log as an action) or like an event (I emit a log, I don't wait a response if it is distributed or not correctly, nor when) ? Use events, with bubble mode ? waitForEmpty/Idle() on root logger to resolve promise on all children and self are not distribuing ?

```typescript

const logger = createLogger({...})

// loggerId can be any type
const child = logger.child({ component: 'http-server', alias: 'public-server' })
const child = logger.child('public-server', {child: true})

child.info('My log', {password: 'secret'})

// Will log {level: 'info', message: 'My log', password: '***', child: true, timestamp: '(date)', logger: 'public-server'}

```