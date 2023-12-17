import { setTimeout } from 'timers/promises'
import {createCallbackHandler, createLogger, ConsoleHandler, createJsonFormatter, createConsoleHandler, createLogfmtFormatter, BreadCrumbHandler} from './index.js'
import {times} from 'lodash-es'

const logger = createLogger()

describe('Logger', () => {

  it('logfmt', () => {
    const logger = createLogger({handlers: [
      createConsoleHandler({
        formatter: createLogfmtFormatter()
      })
    ]})
    logger.info('My message', {
      tag: 'hello',
      str: 'very\ttab',
      str2: 'some\nlines',
      emptyStr: '',
      bool: true,
      numb: 33,
      nul: null,
      undef: undefined,
      'key with space': true,
      createdDate: new Date,
      my: { deep: { data: true }},
      error: new Error('Invalid data'),
      fn() { console.log('hello') },
      symbol: Symbol.for('A symbol')
    })
  })

  it('basic test', () => {
    logger.info('Basic test', {
      createdDate: new Date,
      my: { deep: { data: true }},
      error: new Error('Invalid data'),
      fn() { console.log('hello') },
      symbol: Symbol.for('A symbol')
    })
  })

  it('child test', () => {

    console.log(logger.getParents())

    const child1 = logger.child({child: true})
    const child2 = child1.child({childOfChild: true})

    console.log(child1.getParents())
    console.log(child2.getParents())

    child2.info('I am child of child')

    child2.getHandlers().push(createCallbackHandler({
      maxLevel: 'info',
      formatter: log => `[${log.level}] ${log.message}`,
      async cb(_, log) {
        console.log('child2 has log', log)
      }
    }))

    child2.info('Should not be logged as raw log')
    child2.error('Should be logged as raw log', { error: new Error('Raw error') })

    child1.error('Should not be logged as raw log !')

    child1.getProcessors().push(log => { return {...log, processorProperty: true} })

    child1.info('I should have processorProperty')
    child2.info('I should not have processorProperty')

    ;(child2.getHandlers()[0] as ConsoleHandler).getProcessors().push(log => { return {...log, handlerProcessorProperty: true} })

    child1.info('I should handlerProcessorProperty')
    child2.info('I should have handlerProcessorProperty')

    child1.setHandlers([
        createConsoleHandler({
            formatter: createJsonFormatter({
                indentation: 4,
                customReplacements:[
                    (_, value) => {
                      return typeof value === 'symbol' ? value.toString() : value
                    }
                ]
            })
        })
    ])

    child1.info('Very secret', { password: 'verySecret', symbol: Symbol.for('A symbol'), fn() { console.log('hello') } })
  })

  it('Scenario with Bread Crumb Handler', async () => {

    const appLogger = createLogger({
      id: { name: 'app', uid: '118218' },
      handlers: [
        new BreadCrumbHandler({
          //passthroughMaxLevel: 'notice',
          handler: new ConsoleHandler
        })

      ]
    })

    appLogger.debug('Building app')
    appLogger.info('Starting app')

    const httpServerLogger = appLogger.child({ name: 'http-server' })

    httpServerLogger.debug('Created http server')
    httpServerLogger.info('Server running')

    await Promise.all(times(10, async (i) => {
      await setTimeout(50*i)
      const httpRequestLogger = httpServerLogger.child({ name: 'http-server-request', uid: i})
      httpRequestLogger.info('Received request')

      const commandLogger = httpRequestLogger.child({ name: 'run-process', cmdUid: Math.random()})

      commandLogger.debug('Starting running ls')

      await setTimeout(100)

      if (i === 4) {
        commandLogger.debug('STDERR : invalid file descriptor')
        await setTimeout(50)
        commandLogger.debug('ExitCode 1')

        httpRequestLogger.error('cmd error', { error : new Error('Invalid file descriptor')})
        httpRequestLogger.info('Request ended code 500')
      } else if (i === 8) {
        commandLogger.debug('STDERR : Boooooom')
        await setTimeout(50)
        commandLogger.debug('ExitCode 2')

        appLogger.fatal('Unhandled exception', { error: new Error('Boooooom') })
      } else {
        await setTimeout(100)
        commandLogger.debug('STDOUT : . .. home backups music')
        await setTimeout(50)
        commandLogger.debug('ExitCode 0')

        httpRequestLogger.info('Request ended code 200')
      }
    }))

  })
})
