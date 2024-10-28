import { cloneDeep, mapKeys, chain } from 'lodash-es'
import stringify from 'safe-stable-stringify'
import { EOL } from 'os'
// @ts-ignore
import flat from 'flat'
const flattenObject = flat.flatten

export type LogLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug' // | 'trace'
const levels: LogLevel[] = ['fatal', 'error', 'warning', 'info', 'debug']

export function getMaxLevelsIncludes(maxLogLevel: LogLevel) {
    return levels.slice(0, levels.indexOf(maxLogLevel) + 1)
}

export function shouldBeLogged(logLevel: LogLevel, maxLogLevel: LogLevel, minLogLevel?: LogLevel) {
    return levels.indexOf(logLevel) <= levels.indexOf(maxLogLevel)
        && (minLogLevel ? levels.indexOf(logLevel) >= levels.indexOf(minLogLevel) : true)
}

export function createLogger(loggerOpts: LoggerOpts = {}) {
    return new Logger(loggerOpts)
}

function ensureNotKeys(object: Object, keys: string[]): Object {
    return mapKeys(object, (_value, key) => {
        if (!keys.includes(key)) {
            return key
        }
        let newKey = key

        while (object.hasOwnProperty(newKey)) {
            newKey = '_' + newKey
        }
        return newKey
    })
}

interface ErrorDetails {
    logger: Logger
    log?: Log
    processor?: Processor
    handler?: Handler
}

export class LoggingError extends Error {
    name = 'LoggingError'
    logger: Logger
    log?: Log
    processor?: Processor
    handler?: Handler
    constructor(message: string, options: ErrorOptions & ErrorDetails) {
        super(message, {cause: options.cause})
        this.logger = options.logger
        this.log = options.log
        this.processor = options.processor
        this.handler = options.handler
    }
}

export type ErrorHandler = (error: LoggingError) => void | Promise<void>

export interface Handler {
    // willHandle(log: Log): boolean
    handle(log: Log, logger: Logger): Promise<void>
}

export type Processor = (log: Log, logger: Logger) => Promise<Log | void> | Log | void

export type LoggerId = any

export interface LoggerOpts {
    id?: LoggerId
    useFullQualifiedIdInLogs?: boolean | { separator: string/*, formatter (js to string) ? */ }
    metadata?: Object
    processors?: Processor[]
    handlers?: Handler[]
    onError?: ErrorHandler
}

export interface Log {
    level: LogLevel
    timestamp: Date
    logger?: LoggerId
    message: string
    [k: string]: any
}

/*
    Alternative to errorHandler and onIdle is EventEmitter
    With Children handling but it seems a little bit more complicated
    So keep it simple for the moment
*/
export class Logger {
    protected processors: Processor[]
    protected handlers: Handler[]
    protected metadata: Object
    protected onError?: ErrorHandler
    protected parent?: Logger
    protected id?: LoggerId
    protected fullQualification?: { separator: string }
    protected currentProcessing: Record<'self' | 'children', { count: number, idleCb?: Function, idlePromise?: Promise<void> }> = {
        self: {
            count: 0
        },
        children: {
            count: 0
        }
    }

    constructor(opts: LoggerOpts = {}) {
        this.id = opts.id
        this.metadata = opts.metadata || {}
        this.processors = opts.processors || []
        this.handlers = opts.handlers || [new ConsoleHandler]
        this.onError = opts.onError
        if (opts.useFullQualifiedIdInLogs !== false) {
            this.fullQualification = {
                separator: opts.useFullQualifiedIdInLogs instanceof Object
                    ? opts.useFullQualifiedIdInLogs.separator
                    : '.'
            }
        }
    }

    public getMetadata() {
        return this.metadata
    }

    public setMetadata(metadata: Object) {
        this.metadata = metadata
    }

    public getProcessors() {
        return this.processors
    }

    public setProcessors(processors: Processor[]) {
        this.processors = processors
    }

    public getHandlers() {
        return this.handlers
    }

    public setHandlers(handlers: Handler[]) {
        this.handlers = handlers
    }

    public async waitForIdle(includeChilds = true) {
        let selfPromise: Promise<void>
        let childrenPromise: Promise<void>

        if (this.currentProcessing.self.count === 0) {
            selfPromise = Promise.resolve()
        } else {
            if (!this.currentProcessing.self.idlePromise) {
                this.currentProcessing.self.idlePromise = new Promise(resolve => {
                    this.currentProcessing.self.idleCb = resolve
                })
            }
            selfPromise = this.currentProcessing.self.idlePromise
        }

        if (!includeChilds || this.currentProcessing.children.count === 0) {
            childrenPromise = Promise.resolve()
        } else {
            if (!this.currentProcessing.children.idlePromise) {
                this.currentProcessing.children.idlePromise = new Promise(resolve => {
                    this.currentProcessing.children.idleCb = resolve
                })
            }
            childrenPromise = this.currentProcessing.children.idlePromise
        }

        await Promise.all([
            selfPromise,
            childrenPromise
        ])
    }

    /*
        Promise is resolved when log is fully done
        But is never rejected, because logging caller should not be impacted in case of logging error
        this.handleError() is so called without await
    */
    public async log(level: LogLevel, message: string, metadata?: Object): Promise<void> {
       let log: Log | void
       this.incrementHandlingCount()

       try {
            const loggerResolvedId = this.resolveLoggerId()

            log = {
                timestamp: new Date,
                level,
                ...loggerResolvedId && {logger: loggerResolvedId},
                message,
                ...ensureNotKeys(
                    cloneDeep({...this.metadata, ...metadata}),
                    ['timestamp', 'level', 'logger', 'message']
                )
            }

        } catch (error) {
            this.decrementHandlingCount()
            this.handleError(error as Error, {
                logger: this,
                log: log!
            })
            return
        }

        for (const processor of this.processors) {
            try {
                log = await processor(log as Log, this)
            } catch (error) {
                this.decrementHandlingCount()
                this.handleError(error as Error, {
                    logger: this,
                    log: log as Log,
                    processor
                })
                return
            }

            if (!log) {
                this.decrementHandlingCount()
                return
            }
        }

        await Promise.all(
            this.handlers.map(handler => handler.handle(log as Log, this).catch(error => {
                this.handleError(error as Error, {
                    logger: this,
                    log: log as Log,
                    handler
                })
            }))
        )
        this.decrementHandlingCount()
    }

    public child(id?: LoggerId, metadata?: Object): Logger {
        return this.clone(this, id, cloneDeep({...this.metadata, ...(metadata || {})}))
    }

    public sibling(id?: LoggerId, metadata?: Object): Logger {
        return this.clone(this.parent, id, cloneDeep({...(this.parent?.metadata || {}), ...(metadata || {})}))
    }

    public extends(metadata?: Object): Logger {
        return this.clone(this.parent, this.id, cloneDeep({...this.metadata, ...(metadata || {})}))
    }

    public getId(): LoggerId | undefined {
        return this.id
    }

    public getParent(): Logger | undefined {
        return this.parent
    }

    /**
    * From bottom to top ancestors
    */
    public getParents(): Logger[] {
        let cursor: Logger | undefined = this
        const parents = []

        while(cursor = cursor.getParent()) {
            parents.push(cursor)
        }

        return parents
    }

    public async fatal(message: string, metadata?: Object) {
        return this.log('fatal', message, metadata)
    }

    public async error(message: string, metadata?: Object) {
        return this.log('error', message, metadata)
    }

    public async warning(message: string, metadata?: Object) {
        return this.log('warning', message, metadata)
    }

    public async info(message: string, metadata?: Object) {
        return this.log('info', message, metadata)
    }

    public async debug(message: string, metadata?: Object) {
        return this.log('debug', message, metadata)
    }

    protected checkIdle() {
        if (this.currentProcessing.self.count === 0 && this.currentProcessing.self.idleCb) {
            this.currentProcessing.self.idleCb()
            delete this.currentProcessing.self.idleCb
            delete this.currentProcessing.self.idlePromise
        }

        if (this.currentProcessing.children.count === 0 && this.currentProcessing.children.idleCb) {
            this.currentProcessing.children.idleCb()
            delete this.currentProcessing.children.idleCb
            delete this.currentProcessing.children.idlePromise
        }
    }

    protected incrementHandlingCount() {
        this.currentProcessing.self.count++
        this.getParents().forEach(logger => logger.currentProcessing.children.count++)
    }

    protected decrementHandlingCount() {
        this.currentProcessing.self.count--
        this.checkIdle()
        this.getParents().forEach(logger => {
            logger.currentProcessing.children.count--
            logger.checkIdle()
        })
    }

    protected resolveLoggerId() {
        if (!this.id) {
            return
        }

        if (this.fullQualification) {
            const parents: LoggerId[] = this.getParents().map(l => l.id).filter(id => id) as LoggerId[]
            return [...parents.reverse(), this.id]
                .map(id => typeof id === 'string' ? id : JSON.stringify(id))
                .join(this.fullQualification.separator)
        }

        return this.id
    }

    protected async handleError(error: Error, details: ErrorDetails) {
        let msg = 'Error while logging'
        if (details.processor) {
            msg += ' on processor ' + details.processor.name
        } else if (details.handler) {
            msg += ' on handler ' + details.handler.constructor.name
        }
        msg += ' : ' + error.message
        const loggingError = new LoggingError(msg, {cause: error, ...details})
        if (!this.onError) {
            //process.nextTick(() => {
                throw loggingError
            //})
            return
        }
        this.onError(loggingError)
    }

    protected clone(parent?: Logger, id?: LoggerId, metadata?: Object) {
        const logger = new Logger({
            id,
            metadata,
            processors: [...this.processors],
            handlers: [...this.handlers],
            onError: this.onError
        })

        logger.parent = parent

        return logger
    }
}

export interface BaseHandlerOpts {
    maxLevel?: LogLevel
    minLevel?: LogLevel
    processors?: Processor[]
    formatter?: Formatter
}

interface CreateJsonFormatterOpts {
    customReplacements?: Array<(key: any, value: any) => any>
    replaceDefaultReplacements?: boolean
    indentation?: number
}

export function createJsonFormatter(opts: CreateJsonFormatterOpts = {}): Formatter {
    const replacer = (key: any, value: any) => {
        if (opts.customReplacements && opts.customReplacements.length > 0) {
            value = opts.customReplacements.reduce((value, replacer) => replacer(key, value), value)
        }


        if (!opts.replaceDefaultReplacements) {

            if (value instanceof Object && value.toJSON) {
                return value
            }

            if (value instanceof Error) {
                return {
                    ...value,
                    name: value.name,
                    message: value.message,
                    stack: value.stack
                }
            }

            // if (value instanceof Function) {
            //     return value.toString()
            // }

            // if (typeof value === 'symbol') {
            //     return value.toString()
            // }

        }

        return value
    }

    return (log: Log) => {
        return stringify(log, replacer, opts.indentation)
    }
}

export function createLogfmtFormatter(): Formatter {
    const toJson = createJsonFormatter()

    return (log: Log) => {
        return chain(
            flattenObject<Log, object>(JSON.parse(toJson(log)), {delimiter: '.'})
        )
        .omitBy(v => v === undefined)
        .mapKeys((_, k: string) => k.replace(/ /g, '_'))
        .mapValues(v => {
            if (typeof v === 'string' && !v.match(/\s/)) {
                return v
            }

            return JSON.stringify(v)
        })
        .omitBy(v => v === '' || v === undefined)
        .toPairs()
        .map(kv => kv.join('='))
        .join(' ')
        .value()
    }
}

export type Formatter<T extends any = any> = (log: Log) => T

export abstract class BaseHandler implements Handler {
    protected maxLevel: LogLevel
    protected minLevel: LogLevel
    protected formatter: Formatter
    protected processors: Processor[]

    constructor(opts: BaseHandlerOpts = {}) {
        this.maxLevel = opts.maxLevel || 'debug'
        this.minLevel = opts.minLevel || 'fatal'
        this.processors = opts.processors || []
        this.formatter = opts.formatter || createJsonFormatter()
    }

    public setLevels(levels: Pick<BaseHandlerOpts, 'maxLevel' | 'minLevel'>) {
        if (levels.maxLevel) {
            this.maxLevel = levels.maxLevel
        }
        if (levels.minLevel) {
            this.minLevel = levels.minLevel
        }
    }

    public getProcessors() {
        return this.processors
    }

    public setProcessors(processors: Processor[]) {
        this.processors = processors
    }

    public getFormatter() {
        return this.formatter
    }

    public setFormatter(formatter: Formatter) {
        this.formatter = formatter
    }

    protected willHandle(log: Log) {
        return shouldBeLogged(log.level, this.maxLevel, this.minLevel)
    }

    public async handle(log: Log, logger: Logger) {
        if (!this.willHandle(log)) {
            return
        }

        let logAfterProcessors: Log | void = log

        for (const processor of this.processors) {
            logAfterProcessors = await processor(logAfterProcessors, logger)

            if (!logAfterProcessors) {
                return
            }
        }

        log = logAfterProcessors

        return this.write(this.formatter(log), log, logger)
    }

    protected abstract write(formatted: any, log: Log, logger: Logger): Promise<void>
}

export interface StreamHandlerOpts extends BaseHandlerOpts {
    stream: NodeJS.WritableStream
}

export class StreamHandler extends BaseHandler {
    protected stream: NodeJS.WritableStream

    constructor(opts: StreamHandlerOpts) {
        super(opts)
        this.stream = opts.stream
    }

    protected async write(formatted: any) {
        this.stream.write(formatted.toString() + EOL)
    }
}

export function createStreamHandler(opts: StreamHandlerOpts) {
    return new StreamHandler(opts)
}

export class ConsoleHandler extends BaseHandler {
    protected async write(formatted: any, log: Log) {
        if (['debug', 'info'].includes(log.level)) {
            process.stdout.write(formatted + EOL)
        } else {
            process.stderr.write(formatted + EOL)
        }
    }
}

export class MemoryHandler extends BaseHandler {
    protected writtenLogs: Array<any> = []

    constructor(opts: BaseHandlerOpts) {
        super({formatter: log => log, ...opts})
    }

    protected async write(formatted: any) {
        this.writtenLogs.push(formatted)
    }

    public getWrittenLogs(consume: boolean = false) {
        const writtenLogs = this.writtenLogs

        if (consume) {
            this.clearWrittenLogs()
        }

        return writtenLogs
    }

    public clearWrittenLogs() {
        this.writtenLogs = []
    }
}

export function createConsoleHandler(opts: BaseHandlerOpts = {}) {
    return new ConsoleHandler(opts)
}

export interface CallbackHandlerOpts extends BaseHandlerOpts {
    cb: BaseHandler['write']
}

export class CallbackHandler extends BaseHandler {
    protected cb: BaseHandler['write']

    constructor(opts: CallbackHandlerOpts) {
        super(opts)
        this.cb = opts.cb
    }

    protected async write(formatted: any, log: Log, logger: Logger) {
        return this.cb(formatted, log, logger)
    }
}

export function createCallbackHandler(opts: CallbackHandlerOpts) {
    return new CallbackHandler(opts)
}

export function createBreadCrumbHandler(opts: BreadCrumbHandlerOpts) {
    return new BreadCrumbHandler(opts)
}

export type BreadCrumbHandlerOpts = Omit<BaseHandlerOpts, 'formatter'> & {
    handler: Handler
    flushMinLevel?: LogLevel
    flushMaxLevel?: LogLevel
    passthroughMinLevel?: LogLevel
    passthroughMaxLevel?: LogLevel
    crumbStackSize?: number
}

export class BreadCrumbHandler extends BaseHandler {
    protected handler: Handler
    protected stack = new WeakMap<Logger, Log[]>
    protected flushMinLevel: LogLevel
    protected flushMaxLevel: LogLevel
    protected passthroughMinLevel: LogLevel
    protected passthroughMaxLevel: LogLevel
    protected crumbStackSize: number

    constructor({handler, ...opts}: BreadCrumbHandlerOpts) {
        super(opts)
        this.handler = handler
        this.flushMaxLevel = opts.flushMaxLevel || 'warning'
        this.flushMinLevel = opts.flushMinLevel || 'fatal'
        this.passthroughMaxLevel = opts.passthroughMaxLevel || 'info'
        this.passthroughMinLevel = opts.passthroughMinLevel || 'fatal'
        this.crumbStackSize = opts.crumbStackSize || 10
    }

    public setLevels(levels: Pick<BreadCrumbHandlerOpts, 'passthroughMinLevel' | 'passthroughMaxLevel' | 'minLevel' | 'maxLevel'>) {
        super.setLevels(levels)

        if (levels.passthroughMaxLevel) {
            this.passthroughMaxLevel = levels.passthroughMaxLevel
        }
        if (levels.passthroughMinLevel) {
            this.passthroughMinLevel = levels.passthroughMinLevel
        }
    }

    public getHandler() {
        return this.handler
    }

    protected async write(_: any, log: Log, logger: Logger) {
        // Flushing
        if (shouldBeLogged(log.level, this.flushMaxLevel, this.flushMinLevel)) {
            const previousLogs = this.stack.get(logger) || []
            this.stack.delete(logger)
            await Promise.all([...previousLogs, log].map(log => this.handler.handle(log, logger)))
            return
        }

        // Passthrough
        if (shouldBeLogged(log.level, this.passthroughMaxLevel, this.passthroughMinLevel)) {
            await this.handler.handle(log, logger)
            return
        }

        // breadcrumbing
        [logger, ...logger.getParents()].forEach(loggerBubble => {
            if (!this.stack.has(loggerBubble)) {
                this.stack.set(loggerBubble, [])
            }
            this.stack.get(loggerBubble)!.push(log)
            if (this.stack.get(loggerBubble)!.length > this.crumbStackSize) {
                this.stack.get(loggerBubble)!.shift()
            }
        })
    }
}
