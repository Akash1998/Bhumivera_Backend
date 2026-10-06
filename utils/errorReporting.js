const DEFAULT_MESSAGES = Object.freeze({
  400: 'The request could not be processed.',
  401: 'Authentication is required.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested resource was not found.',
  409: 'The request conflicts with the current resource state.',
  429: 'Too many requests. Please try again later.',
  500: 'An unexpected server error occurred.',
});

const DEFAULT_ACTIONS = Object.freeze({
  400: 'Check the submitted information and try again.',
  401: 'Sign in and try again.',
  403: 'Contact an administrator if you need access.',
  404: 'Check the resource identifier and try again.',
  409: 'Refresh the page and try again.',
  429: 'Wait briefly before trying again.',
  500: 'Try again later. Contact support if the problem continues.',
});

function createError(status, code, message, userAction, details) {
  const normalizedStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const error = new Error(message || DEFAULT_MESSAGES[normalizedStatus] || DEFAULT_MESSAGES[500]);
  error.name = 'ApplicationError';
  error.status = normalizedStatus;
  error.code = code || (normalizedStatus >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED');
  error.userAction = userAction || DEFAULT_ACTIONS[normalizedStatus] || DEFAULT_ACTIONS[500];
  if (details !== undefined) error.details = details;
  return error;
}

function serializeError(error, fallbackStatus = 500) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : fallbackStatus;
  return {
    status,
    body: {
      code: error?.code || (status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED'),
      message: error?.message || DEFAULT_MESSAGES[status] || DEFAULT_MESSAGES[500],
      userAction: error?.userAction || DEFAULT_ACTIONS[status] || DEFAULT_ACTIONS[500],
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
  };
}

function sendError(res, error, fallbackStatus = 500) {
  const response = serializeError(error, fallbackStatus);
  return res.status(response.status).json(response.body);
}

function normalizeErrorResponses(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = body => {
    if (res.statusCode < 400 || res.statusCode > 599) return originalJson(body);
    const status = res.statusCode;
    const normalized = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
    const hasApplicationCode = typeof normalized.code === 'string' && normalized.code.length > 0;
    normalized.code = normalized.code || (status >= 500 ? 'INTERNAL_SERVER_ERROR' : `HTTP_${status}`);
    normalized.message = normalized.message || (status >= 500 ? DEFAULT_MESSAGES[500] : DEFAULT_MESSAGES[status] || 'The request could not be completed.');
    normalized.userAction = normalized.userAction || (status >= 500 ? DEFAULT_ACTIONS[500] : DEFAULT_ACTIONS[status] || 'Review the request and try again.');
    if (status >= 500) {
      delete normalized.error;
      delete normalized.stack;
      if (!hasApplicationCode) normalized.message = DEFAULT_MESSAGES[500];
    }
    return originalJson(normalized);
  };
  next();
}

module.exports = { createError, serializeError, sendError, normalizeErrorResponses };
