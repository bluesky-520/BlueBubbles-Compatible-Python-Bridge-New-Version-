import CryptoJS from 'crypto-js';

export const ResponseMessages = {
  SUCCESS: 'Success',
  BAD_REQUEST: 'Bad Request',
  SERVER_ERROR: 'Server Error',
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NO_DATA: 'No Data',
  NOT_FOUND: 'Not Found',
  UNKNOWN_IMESSAGE_ERROR: 'Unknown iMessage Error',
  GATEWAY_TIMEOUT: 'Gateway Timeout'
};

export const ErrorTypes = {
  SERVER_ERROR: 'Server Error',
  DATABASE_ERROR: 'Database Error',
  IMESSAGE_ERROR: 'iMessage Error',
  SOCKET_ERROR: 'Socket Error',
  VALIDATION_ERROR: 'Validation Error',
  AUTHENTICATION_ERROR: 'Authentication Error',
  GATEWAY_TIMEOUT: 'Gateway Timeout'
};

export const createSuccessResponse = (data, message = ResponseMessages.SUCCESS, metadata = null) => {
  const res = { status: 200, message, data };
  if (metadata) res.metadata = metadata;
  return res;
};

export const createServerErrorResponse = (
  error,
  errorType = ErrorTypes.SERVER_ERROR,
  message = ResponseMessages.SERVER_ERROR,
  data = null
) => {
  const res = {
    status: 500,
    message,
    error: { type: errorType, message: error }
  };
  if (data) res.data = data;
  return res;
};

export const createBadRequestResponse = (message) => ({
  status: 400,
  message: ResponseMessages.BAD_REQUEST,
  error: { type: ErrorTypes.VALIDATION_ERROR, message }
});

export const createNoDataResponse = () => ({
  status: 200,
  message: ResponseMessages.NO_DATA
});

const shouldEncrypt = () => {
  const flag = process.env.ENCRYPT_COMS || process.env.ENCRYPT_COMMS || 'false';
  return String(flag).toLowerCase() === 'true';
};

const getPassphrase = () =>
  process.env.SERVER_PASSWORD || process.env.PASSWORD || process.env.SOCKET_ENCRYPTION_KEY || '';

export const sendSocketResponse = (socket, callback, channel, data) => {
  const resData = { ...data, encrypted: false };
  const encrypt = shouldEncrypt();
  const passphrase = getPassphrase();

  if (encrypt && passphrase && channel !== 'attachment-chunk') {
    if (typeof resData.data === 'string') {
      resData.data = CryptoJS.AES.encrypt(resData.data, passphrase).toString();
      resData.encrypted = true;
    } else if (resData.data !== undefined) {
      resData.data = CryptoJS.AES.encrypt(JSON.stringify(resData.data), passphrase).toString();
      resData.encrypted = true;
    }
  }

  if (callback) {
    callback(resData);
  } else if (channel) {
    socket.emit(channel, resData);
  }
};
