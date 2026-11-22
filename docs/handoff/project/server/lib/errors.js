// Throw this from services and routes. The error handler in app.js turns it into
// { "error": { "code": "...", "message": "..." } } with the given status.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
