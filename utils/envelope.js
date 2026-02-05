export const sendSuccess = (res, data, message = 'Success', status = 200, metadata = null) => {
  const statusCode = Number(status) || 200;
  const payload = {
    status: statusCode,
    message,
    data
  };
  if (metadata) {
    payload.metadata = metadata;
  }
  res.status(statusCode).json(payload);
};

export const sendError = (res, status, error, message = 'Error') => {
  const payload = {
    status,
    message: message === 'Error' ? defaultMessageForStatus(status) : message,
    error: typeof error === 'string' ? error : error
  };
  res.status(status).json(payload);
};

/** BlueBubbles-official-style error body: { type, message }. Use for attachment/chat/message 404s. */
export const BLUEBUBBLES_ERROR_TYPES = {
  DATABASE_ERROR: 'Database Error',
  VALIDATION_ERROR: 'Validation Error',
  SERVER_ERROR: 'Server Error',
  AUTHENTICATION_ERROR: 'Authentication Error',
  NOT_FOUND: 'Not Found'
};

/** Send error response matching official BlueBubbles API shape: error: { type, message }. */
export const sendBlueBubblesError = (res, status, errorMessage, options = {}) => {
  const { message = defaultMessageForStatus(status), type = BLUEBUBBLES_ERROR_TYPES.DATABASE_ERROR } = options;
  res.status(status).json({
    status,
    message,
    error: { type, message: errorMessage }
  });
};

function defaultMessageForStatus(status) {
  const map = {
    400: "You've made a bad request! Please check your request params & body",
    401: 'You are not authorized to access this resource',
    403: 'You are forbidden from accessing this resource',
    404: 'The requested resource was not found',
    500: 'The server has encountered an error',
    504: 'The server took too long to response!'
  };
  return map[status] || 'Error';
}
