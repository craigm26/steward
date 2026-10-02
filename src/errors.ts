// An error that carries the HTTP status the API should answer with.
export class HttpError extends Error {
	constructor(readonly status: number, message: string, readonly code?: string) {
		super(message);
	}
}
