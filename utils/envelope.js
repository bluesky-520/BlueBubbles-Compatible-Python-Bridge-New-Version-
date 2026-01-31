export const sendSuccess = (res, data, message = 'Success', status = 200, metadata = null) => {
  const payload = {
    status,
    message,
    data
  };
  if (metadata) {
    payload.metadata = metadata;
  }
  res.status(status).json(payload);
};

export const sendError = (res, status, error, message = 'Error') => {
  res.status(status).json({
    status,
    message,
    error
  });
};
