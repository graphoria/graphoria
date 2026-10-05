const setClientHeaders = (headers: Headers) => {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "*");
  headers.set("Access-Control-Allow-Headers", "*");

  headers.set("Content-Type", "application/json");
};

export class ClientResponse extends Response {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body ? JSON.stringify(body) : null, init);

    setClientHeaders(this.headers);
  }
}

export class S200 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 200 });
  }
}

// Sends JSON text as is. S200 encodes a string body as a JSON string, which a
// handler that returns a string relies on, so serialized text has its own class.
export class S200Serialized extends Response {
  constructor(json: string) {
    super(json, { status: 200 });

    setClientHeaders(this.headers);
  }
}

export class S400 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 400 });
  }
}

export class S401 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 401 });
  }
}

export class S403 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 403 });
  }
}

export class S404 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 404 });
  }
}

export class S429 extends ClientResponse {
  constructor(retryAfterMs: number) {
    super({ errors: [{ message: "Rate limit exceeded" }] }, { status: 429 });

    // Seconds, and never 0: a caller told to retry immediately retries
    // immediately, which is the traffic the limit is there to stop.
    this.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }
}

export class S500 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 500 });
  }
}

export class S503 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 503 });
  }
}
