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
  res.status(status).json({
    status,
    message,
    error
  });
};
