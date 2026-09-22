import { createConnection, createServer } from "node:net";

import type { Server, Socket } from "node:net";

export type TcpProxy = {
  port: number;
  /** Refuses new connections and cuts every open one, as a stopped server would. */
  down: () => Promise<void>;
  /** Listens again on the same port. */
  up: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * A TCP relay in front of a backing service, so a test can take the service
 * away from the server under test and give it back without touching the
 * container that every other suite shares.
 */
export const createTcpProxy = async (target: { host: string; port: number }): Promise<TcpProxy> => {
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let port = 0;

  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };

  const up = () =>
    new Promise<void>((resolve) => {
      server = createServer((client) => {
        const upstream = createConnection(target.port, target.host);
        track(client);
        track(upstream);
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.pipe(upstream).pipe(client);
      });
      server.listen(port, "127.0.0.1", () => {
        port = (server!.address() as { port: number }).port;
        resolve();
      });
    });

  const down = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
    });

  await up();

  return {
    get port() {
      return port;
    },
    down,
    up,
    close: down,
  };
};
