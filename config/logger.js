import fs from 'fs';
import path from 'path';
import winston from 'winston';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    const msg = stack ? `${message}\n${stack}` : message;
    return `[${timestamp}] [${level.toUpperCase()}]: ${msg}`;
  })
);

function ensureLogsDir() {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (_) {
    // ignore
  }
}

ensureLogsDir();

/**
 * Logger settings (match BlueBubbles server expectations):
 * - Default level is INFO (quiet by default)
 * - Override with LOG_LEVEL=debug|info|warn|error
 */
const envLevel = (process.env.LOG_LEVEL || '').toLowerCase().trim();
const level = envLevel || (process.env.NODE_ENV === 'production' ? 'info' : 'info');

const logger = winston.createLogger({
  level,
  format: logFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ],
  exceptionHandlers: [
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: 'logs/rejections.log' })
  ]
});

export default logger;