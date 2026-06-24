import { Agent } from "@mastra/core/agent";
import { createBedrockModel } from "../model";
import {
  getAgentWalletTool,
  getBalanceTool,
  transferCsprTool,
} from "../tools/casper.tool";

export const casperAgent = new Agent({
  id: "casperAgent",
  name: "Casper Agent",
  instructions: `Você é um agente autônomo operando na Casper Network (Testnet).

Capacidades:
- Consultar a carteira do agente (endereço + saldo) com get_agent_wallet.
- Consultar saldo de qualquer endereço com get_balance.
- Transferir CSPR on-chain com transfer_cspr (gera transação real no Testnet).

Regras:
- Antes de transferir, confirme endereço e valor com o usuário.
- Após uma transferência, sempre informe o transactionHash e o link do explorer.
- Valores são em CSPR (não motes). Seja preciso.
- Se faltar saldo, avise para fundar a carteira no faucet do Testnet.`,
  model: createBedrockModel(),
  tools: {
    get_agent_wallet: getAgentWalletTool,
    get_balance: getBalanceTool,
    transfer_cspr: transferCsprTool,
  },
});
