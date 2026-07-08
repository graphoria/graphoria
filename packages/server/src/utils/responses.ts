export class ClientResponse extends Response {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body ? JSON.stringify(body) : null, init);

    this.headers.set("Access-Control-Allow-Origin", "*");
    this.headers.set("Access-Control-Allow-Credentials", "true");
    this.headers.set("Access-Control-Allow-Methods", "*");
    this.headers.set("Access-Control-Allow-Headers", "*");

    this.headers.set("Content-Type", "application/json");
  }
}

export class S200 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 200 });
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

export class S404 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 404 });
  }
}

export class S500 extends ClientResponse {
  constructor(body?: object | null, init?: ResponseInit) {
    super(body, { ...init, status: 500 });
  }
}
