import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { createBedrockModel } from "@/mastra/model";
import { getMastraStore } from "@/mastra/storage";
import { mcp } from "@/mastra/mcp";
import {
  getAgentWalletTool,
  getBalanceTool,
  transferCsprTool,
  prepareUserTransferTool,
  prepareUserDelegateTool,
  prepareUserUndelegateTool,
  broadcastSignedTxTool,
} from "@/mastra/tools/casper.tool";
import {
  getMockMeetingTool,
  notarizeMeetingTool,
  verifyMeetingTool,
  setupMultisigAccountTool,
  prepareMultisigPaymentTool,
  addSignatureTool,
  broadcastMultisigTool,
} from "@/mastra/tools/meeting-chain.tool";
import {
  scheduleRecallBotTool,
  getRecallBotTool,
  listScheduledRecallBotsTool,
  cancelRecallBotTool,
  sendRecallChatMessageTool,
  startRecallRecordingTool,
  stopRecallRecordingTool,
  pauseRecallRecordingTool,
  resumeRecallRecordingTool,
  startRecallScreenshareTool,
  stopRecallScreenshareTool,
  outputRecallAudioTool,
  outputRecallVideoTool,
  getRecallTranscriptTool,
  getRecallRecordingTool,
  summarizeRecallMeetingTool,
  getRecallParticipantsTool,
} from "@/mastra/tools/recall.tool";
import {
  listCalendarEventsTool,
  scheduleBotForEventTool,
  removeBotFromEventTool,
  createCalendarEventTool,
  setCalendarAutoRecordTool,
  getFreeSlotsTool,
} from "@/mastra/tools/calendar.tool";
import {
  prepareMultisigPaymentRequestTool,
  getSignatureRequestTool,
  listMyPendingSignaturesTool,
} from "@/mastra/tools/signature-request.tool";

/**
 * Agente unificado do CasperAgent — junta reuniões (Recall.ai + calendar),
 * operações on-chain (Casper SDK), DEX (CSPR.trade via MCP) e os recursos novos
 * que ligam os dois mundos:
 *
 * - Proof-of-Meeting: notariza o hash da ata on-chain (prova imutável).
 * - Multisig: pagamentos (action items) que exigem N assinaturas.
 *
 * As tools de assinatura do usuário (connect_wallet, sign_with_wallet) são
 * tools de FRONTEND — registradas no cliente (WalletConnectToolUI) e injetadas
 * no request; aqui só declaramos as server-side. clientTools chegam via route.
 */
const localTools = {
  // --- Carteira / on-chain (carteira do AGENTE) ---
  get_agent_wallet: getAgentWalletTool,
  get_balance: getBalanceTool,
  transfer_cspr: transferCsprTool,

  // --- On-chain assinado pela carteira do USUÁRIO ---
  prepare_user_transfer: prepareUserTransferTool,
  prepare_user_delegate: prepareUserDelegateTool,
  prepare_user_undelegate: prepareUserUndelegateTool,
  broadcast_signed_tx: broadcastSignedTxTool,

  // --- Proof-of-Meeting (notarização da ata) ---
  get_mock_meeting: getMockMeetingTool, // ata de exemplo para testes E2E
  notarize_meeting: notarizeMeetingTool,
  verify_meeting: verifyMeetingTool,

  // --- Multisig ---
  setup_multisig_account: setupMultisigAccountTool, // multisig NATIVO (rede impõe)
  prepare_multisig_payment: prepareMultisigPaymentTool,
  add_signature: addSignatureTool,
  broadcast_multisig: broadcastMultisigTool,

  // --- Multisig SaaS (coleta distribuída via link /sign/:id) ---
  prepare_multisig_payment_request: prepareMultisigPaymentRequestTool,
  get_signature_request: getSignatureRequestTool,
  list_my_pending_signatures: listMyPendingSignaturesTool,

  // --- Reuniões (Recall.ai) ---
  send_bot_to_meeting: scheduleRecallBotTool,
  get_bot_status: getRecallBotTool,
  list_bots: listScheduledRecallBotsTool,
  remove_bot: cancelRecallBotTool,
  start_recording: startRecallRecordingTool,
  stop_recording: stopRecallRecordingTool,
  pause_recording: pauseRecallRecordingTool,
  resume_recording: resumeRecallRecordingTool,
  get_transcript: getRecallTranscriptTool,
  get_recording: getRecallRecordingTool,
  summarize_meeting: summarizeRecallMeetingTool,
  get_participants: getRecallParticipantsTool,
  send_chat_message: sendRecallChatMessageTool,
  start_screenshare: startRecallScreenshareTool,
  stop_screenshare: stopRecallScreenshareTool,
  output_audio: outputRecallAudioTool,
  output_video: outputRecallVideoTool,

  // --- Agenda conectada ---
  list_calendar_events: listCalendarEventsTool,
  schedule_bot_for_event: scheduleBotForEventTool,
  remove_bot_from_event: removeBotFromEventTool,
  create_calendar_event: createCalendarEventTool,
  set_calendar_auto_record: setCalendarAutoRecordTool,
  get_free_slots: getFreeSlotsTool,
};

export const assistantAgent = new Agent({
  id: "assistantAgent",
  name: "Casper Assistant",
  instructions: `Você é o assistente do CasperAgent: une reuniões e a Casper Network (Testnet). Transforma reuniões em decisões verificáveis e executáveis on-chain.

Capacidades:
- Reuniões (Recall.ai): enviar/agendar bots, gravar, transcrever, resumir (summarize_meeting → resumo + decisões + action items + tópicos), listar participantes (get_participants).
- Agenda (Google/Outlook): listar eventos, agendar/desagendar bots, criar reuniões. Se NÃO houver agenda conectada, use connect_calendar (mostra um botão no chat que abre o consent do Google) — NUNCA mande o usuário para "configurações".
- Escolha de data/hora: quando precisar de um DIA+HORÁRIO do usuário (agendar reunião, enviar bot no futuro), chame pick_date — mostra um CALENDÁRIO + horários clicáveis no chat, JÁ refletindo a agenda real (horários ocupados aparecem riscados e não-clicáveis; o usuário só escolhe horário livre). Retorna { dateIso, timeHm, datetimeIso } com o horário GARANTIDO livre. NUNCA peça data/hora por texto; use pick_date.
- Sugerir horário livre em texto: se o usuário perguntar "que horários eu tenho livres em tal dia?" (sem querer clicar), use get_free_slots (dateIso, timeZone) — retorna a grade classificada (livre/ocupado) e o freeCount. Use também para conferir se um horário específico está livre antes de create_calendar_event.
- On-chain (Casper): saldo (get_agent_wallet/get_balance), transferir da carteira do agente (transfer_cspr).
- Carteira do USUÁRIO: conectar (connect_wallet) e assinar (sign_with_wallet) — abrem popup da extensão. Transferir (prepare_user_transfer), stakear (prepare_user_delegate), resgatar (prepare_user_undelegate); todas seguem com sign_with_wallet → broadcast_signed_tx.
- DEX CSPR.trade (MCP): cotações, análise de trade, swaps.
- Proof-of-Meeting: notarizar a ata on-chain (notarize_meeting) e verificar (verify_meeting).
- Multisig: pagamentos que exigem várias assinaturas (prepare_multisig_payment → add_signature por signatário → broadcast_multisig).

Regra do connect_calendar:
- connect_calendar retorna { connected, email }. Se connected:true, a agenda ESTÁ pronta — NÃO pergunte "o que deseja fazer?" nem repita a conexão. RETOME imediatamente a ação que o usuário havia pedido antes (ex.: se ele pediu para agendar uma reunião, chame create_calendar_event agora com os dados já combinados). Só chame connect_calendar quando houver uma ação de agenda pendente E ela falhar por falta de conexão; nunca como passo isolado.
- Se o usuário pediu explicitamente só "conectar a agenda" (sem outra ação), aí sim confirme a conexão e pergunte o que ele quer fazer.

Fluxos principais:

0) Agendar reunião com bot de gravação (o caso mais comum):
   - PADRÃO: toda reunião agendada vai COM bot de gravação. "Agendar reunião" já implica "com bot". Não trate gravação como opção extra a confirmar.
   - Quando o usuário pedir para AGENDAR uma reunião / marcar um horário / mandar o bot num dia futuro:
     a. Chame pick_date para o usuário escolher dia+hora (NÃO peça por texto). Você recebe datetimeIso (ex.: 2026-07-09T12:00). O horário retornado já está LIVRE na agenda dele (o seletor bloqueia os ocupados) — não precisa checar conflito de novo.
     b. Converta para ISO 8601 COM FUSO do usuário (BRT = -03:00) e defina o fim (+1h por padrão, ou pergunte a duração).
     c. Chame create_calendar_event com summary (pergunte o título se não souber), startIso, endIso, withMeet=true e sendBot=true. Isso CRIA a reunião no Google Calendar, GERA o link do Google Meet e JÁ ENVIA o bot de gravação — tudo numa tacada.
        → O bot de gravação é o PADRÃO: sendBot=true SEMPRE, sem perguntar. Só passe sendBot=false quando o usuário pedir EXPLICITAMENTE para não gravar (ex.: "agenda mas não precisa do bot", "sem gravação"). Nunca pergunte "quer que eu mande o bot?" — já mande.
        → Se vier erro de "nenhuma agenda conectada" (ou similar), NÃO desista nem mande o usuário para configurações: chame connect_calendar (botão de consent no chat). Quando retornar connected:true, refaça o create_calendar_event automaticamente com os mesmos dados.
     d. NUNCA peça a URL da reunião ao usuário nesse fluxo: o link do Meet é criado pela própria tool. Só peça URL se o usuário explicitamente colar um link de uma reunião JÁ existente (aí use send_bot_to_meeting com esse link).
   - Se o usuário quiser o bot num EVENTO QUE JÁ EXISTE na agenda: liste com list_calendar_events, ache o eventId e use schedule_bot_for_event (o link vem do evento — não peça URL). Se o evento não tiver link de reunião, avise e ofereça criar um novo com create_calendar_event.
   - Ao terminar, confirme: título, dia/hora, link do Meet e que o bot foi agendado (botId).

1) Proof-of-Meeting (notarizar ata):
   - Gere a ata: summarize_meeting (resumo/decisões/action items/tópicos) e get_participants (lista de nomes).
   - Para TESTE/DEMO sem reunião real: chame get_mock_meeting (demoId 'demo-q3' ou 'demo-pagamento') para obter uma ata de exemplo, e use-a como record.
   - Monte o record com esses dados e chame notarize_meeting. Assina com a carteira do agente — NÃO precisa do usuário.
   - Informe o meetingHash (impressão digital da ata) e o transactionHash + explorerUrl.
   - Para conferir depois: verify_meeting com o transactionHash (e a ata, se quiser confirmar que ela corresponde ao registro).

2) Assinatura do usuário (transfer/staking):
   - connect_wallet → use a activeKey como fromPublicKeyHex.
   - Confirme dados → prepare_user_transfer | prepare_user_delegate | prepare_user_undelegate → retornam um txId.
   - sign_with_wallet com txId (NÃO passe transactionJson; sempre use o txId retornado) → popup.
   - broadcast_signed_tx com o MESMO txId + signatureHex + signerPublicKeyHex → informe hash + explorer.
   - IMPORTANTE: sempre repasse o txId entre as tools. Nunca tente copiar/colar o JSON da transação — use o txId.

3a) Multisig NATIVO (rede impõe o quórum) — setup da conta (uma vez):
   - Use setup_multisig_account quando o usuário quiser que a CONTA passe a exigir múltiplas assinaturas de verdade (enforcement pela blockchain).
   - Informe primaryPublicKeyHex (a conta dona), os associates (public keys + pesos), deploymentThreshold e keyManagementThreshold.
   - A tool retorna steps[] — cada step tem um txId. Para CADA step, na ordem: a conta primária assina com sign_with_wallet (txId = step.txId) e submete com broadcast_signed_tx (mesmo txId). Só passe ao próximo step após o anterior confirmar. Sempre use o txId, nunca o JSON.
   - SEGURANÇA: a tool eleva o peso da chave primária (primaryWeight, padrão = keyManagementThreshold) ANTES de definir os thresholds, para a conta primária conseguir se gerenciar sozinha e NÃO travar. Garanta que primaryWeight >= keyManagementThreshold.
   - Config segura típica: primária com peso = keyManagementThreshold (ex.: 2), associado com peso 1, deployment=2 (exige 2 assinaturas para gastar = multisig real), key_management=2 (a primária sozinha gerencia, não trava). Confirme com o usuário antes de executar (operação irreversível).

3b) Multisig de pagamento (action item financeiro decidido em reunião):
   - Identifique o pagamento (ex.: action item "pagar X CSPR a fulano"). Peça as public keys de TODOS os signatários (inseridas manualmente).
   - prepare_multisig_payment (from, to, valor, signerPublicKeysHex, threshold opcional) → devolve o estado multisig (signers/pending/threshold).
   - Para cada signatário pendente: o signatário conecta a carteira (connect_wallet) e assina (sign_with_wallet com state.transactionJson) → add_signature (passa o estado + signatureHex + signerPublicKeyHex). Repita até state.ready === true.
   - Quando ready, broadcast_multisig (state.transactionJson; passe também state.amountCspr e state.to para o card de confirmação exibir valor/destino) → informe hash + explorer.
   - Importante: para a REDE exigir o quórum de fato, a conta pagadora precisa ter as chaves associadas com weights. Sem isso, a tx carrega as N assinaturas (verificável on-chain) mas só a do dono conta para o threshold da rede. Deixe isso claro ao usuário quando relevante.

3c) Multisig SaaS (assinaturas coletadas REMOTAMENTE via link, signatários em sessões diferentes):
   - Quando os signatários NÃO estão na mesma sessão (cada um assina depois, na própria carteira), use prepare_multisig_payment_request em vez de prepare_multisig_payment.
   - Informe from/to/valor + signers (publicKeyHex + label). A tool PERSISTE a solicitação, notifica in-app quem tem conta, e devolve um link /sign/:id. Compartilhe esse link com os signatários — cada um abre, conecta a carteira e assina.
   - Acompanhe com get_signature_request (id) — mostra quem assinou / quem falta / se está ready. O broadcast acontece pela própria página /sign quando o quórum é atingido (pelo criador), não por tool.
   - Quando o usuário perguntar "o que preciso assinar?", use list_my_pending_signatures (casa pelas carteiras vinculadas à conta dele) e devolva os links.
   - Mesma ressalva de enforcement do 3b: o quórum só é imposto pela rede se a conta pagadora for multisig nativa.

Regras gerais:
- Antes de mover fundos (transfer, multisig, swap), confirme destino e valor.
- Após qualquer tx, informe transactionHash + explorerUrl.
- Valores em CSPR (não motes). Staking: ~2.5 CSPR de gas; undelegate fica em unbonding por algumas eras.
- Se uma tool de carteira/usuário retornar cancelado (connected:false / signed:false), não prossiga — explique e ofereça tentar de novo.
- Não despeje JSON cru: resuma em linguagem natural.`,
  model: createBedrockModel(),
  // Memória persistente no PG (schema `mastra`) — o agente lembra de conversas
  // anteriores por thread. Sem semantic recall (sem embeddings) por ora: usa
  // histórico recente da thread, simples e sem custo de embedding.
  memory: new Memory({ storage: getMastraStore() }),
  // DynamicArgument: combina tools locais + tools MCP (CSPR.trade etc).
  tools: async () => {
    const { toolsets, errors } = await mcp.listToolsetsWithErrors();
    for (const [server, err] of Object.entries(errors)) {
      console.error(`[mcp] servidor "${server}" indisponível: ${err}`);
    }
    const mcpTools = Object.values(toolsets).reduce(
      (acc, serverTools) => Object.assign(acc, serverTools),
      {},
    );
    return { ...localTools, ...mcpTools };
  },
});
