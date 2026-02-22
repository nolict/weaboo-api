export enum LogLevel {
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG',
}

const colors = {
  reset: '\x1b[0m',
  info: '\x1b[36m',
  success: '\x1b[32m',
  warning: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[35m',
}

export const Logger = {
  log(level: LogLevel, message: string, data?: unknown): void {
    const timestamp = new Date().toISOString()
    const color = colors[level.toLowerCase() as keyof typeof colors] ?? colors.reset

    console.log(`${color}[${timestamp}] [${level}]${colors.reset} ${message}`)

    if (data !== undefined) {
      console.log(data)
    }
  },

  info(message: string, data?: unknown): void {
    this.log(LogLevel.INFO, message, data)
  },

  success(message: string, data?: unknown): void {
    this.log(LogLevel.SUCCESS, message, data)
  },

  warning(message: string, data?: unknown): void {
    this.log(LogLevel.WARNING, message, data)
  },

  error(message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, message, data)
  },

  debug(message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, message, data)
  },
}
