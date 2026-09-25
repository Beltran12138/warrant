import {
  type CommandIO,
  PluginCommand,
} from "@metamask/agent-wallet/plugin";

type IntrospectResult = {
  services: Record<string, string[]>;
};

/** 临时开发命令：转储 ctx 各 service 的真实方法名，作为 preflight 编码的 ground truth。发布前删除。 */
export default class MandateIntrospect extends PluginCommand<IntrospectResult> {
  static override description = "[dev] Dump ctx service method names.";

  static override requiresAuth = false;
  static override requiresInit = false;

  protected readonly pluginCommandId = "mandate:introspect";

  async execute(_io: CommandIO): Promise<IntrospectResult> {
    const ctx = this.ctx as unknown as Record<string, unknown>;
    const services: Record<string, string[]> = {};
    const names = [
      "priceService",
      "tokenService",
      "accountService",
      "networkRegistry",
      "feesService",
      "walletStateManager",
      "swapQuoteStore",
      "authService",
    ];
    for (const n of names) {
      let svc: unknown;
      try {
        svc = ctx[n];
      } catch (e) {
        services[n] = [`<denied: ${(e as Error).message}>`];
        continue;
      }
      if (!svc) {
        services[n] = ["<absent>"];
        continue;
      }
      const methods = new Set<string>();
      let proto: object | null = Object.getPrototypeOf(svc);
      while (proto && proto !== Object.prototype) {
        for (const m of Object.getOwnPropertyNames(proto)) {
          if (m !== "constructor" && typeof (svc as Record<string, unknown>)[m] === "function") {
            methods.add(m);
          }
        }
        proto = Object.getPrototypeOf(proto);
      }
      // own enumerable function props too
      for (const m of Object.keys(svc as object)) {
        if (typeof (svc as Record<string, unknown>)[m] === "function") methods.add(m);
      }
      services[n] = [...methods].sort();
    }
    // publicClient / walletExecutor 是工厂函数，单列
    for (const f of ["publicClient", "walletExecutor"]) {
      try {
        services[f] = [`factory:${typeof ctx[f]}`];
      } catch (e) {
        services[f] = [`<denied: ${(e as Error).message}>`];
      }
    }
    return { services };
  }
}
