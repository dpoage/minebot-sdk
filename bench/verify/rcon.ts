import net from "node:net";

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;

interface Packet {
  id: number;
  type: number;
  body: string;
}

/**
 * Minimal Minecraft RCON client (Source RCON protocol). Used by verifiers to read
 * ground truth from the server instead of trusting a body.
 * Responses longer than one packet (about 4 KiB) are truncated by the server.
 */
export class Rcon {
  readonly #socket: net.Socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<number, PromiseWithResolvers<Packet>>();
  #closed: Error | null = null;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    const fail = (err: Error) => {
      this.#closed = err;
      for (const pending of this.#pending.values()) pending.reject(err);
      this.#pending.clear();
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("RCON connection closed")));
  }

  static async connect(host: string, port: number, password: string): Promise<Rcon> {
    const socket = net.connect({ host, port });
    const connected = Promise.withResolvers<void>();
    socket.once("connect", () => connected.resolve());
    socket.once("error", connected.reject);
    await connected.promise;
    const rcon = new Rcon(socket);
    const reply = await rcon.#send(TYPE_AUTH, password);
    if (reply.id === -1) {
      rcon.close();
      throw new Error("RCON authentication failed");
    }
    return rcon;
  }

  /** Runs a server command and returns its text output. */
  async command(command: string): Promise<string> {
    return (await this.#send(TYPE_COMMAND, command)).body;
  }

  close(): void {
    this.#socket.end();
  }

  #send(type: number, body: string): Promise<Packet> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    const payload = Buffer.from(body, "utf8");
    const packet = Buffer.alloc(14 + payload.length);
    packet.writeInt32LE(10 + payload.length, 0); // length excludes this field
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12); // body, then two NUL terminators (already zeroed)
    const pending = Promise.withResolvers<Packet>();
    this.#pending.set(id, pending);
    this.#socket.write(packet);
    return pending.promise;
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readInt32LE(0);
      if (this.#buffer.length < 4 + length) return;
      const packet: Packet = {
        id: this.#buffer.readInt32LE(4),
        type: this.#buffer.readInt32LE(8),
        body: this.#buffer.toString("utf8", 12, 4 + length - 2),
      };
      this.#buffer = this.#buffer.subarray(4 + length);
      // A failed login answers with id -1, so it cannot be matched by id; it answers the oldest request.
      const key = packet.id === -1 ? this.#pending.keys().next().value : packet.id;
      if (key === undefined) continue;
      const pending = this.#pending.get(key);
      this.#pending.delete(key);
      pending?.resolve(packet);
    }
  }
}
