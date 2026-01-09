export class HaError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'HaError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class AuthenticationError extends HaError {
  constructor(message: string, details?: unknown) {
    super(message, 'AUTH_ERROR', 401, details);
    this.name = 'AuthenticationError';
  }
}

export class ApiError extends HaError {
  constructor(message: string, statusCode: number, details?: unknown) {
    super(message, 'API_ERROR', statusCode, details);
    this.name = 'ApiError';
  }
}

export class ConfigurationError extends HaError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIG_ERROR', undefined, details);
    this.name = 'ConfigurationError';
  }
}
