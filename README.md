# Observador de builds Cloudflare → Discord

Worker que avisa no Discord quando a build de um site falha na Cloudflare e **apaga o aviso sozinho** quando a build volta a funcionar.

Cobre os dois tipos de projeto:

| Tipo | Como é vigiado | Tempo até o aviso |
|---|---|---|
| **Cloudflare Pages** (os sites Astro `*.pages.dev`) | O cron consulta a API do Pages a cada 5 min | até 5 min depois da falha |
| **Workers com Workers Builds** (Git) | Event Subscriptions → fila → este Worker | na hora |

Sites novos entram **automaticamente**, sem configuração manual:
- **Pages:** toda verificação lista todos os projetos da conta.
- **Workers:** a cada 15 min o Worker cria a assinatura de eventos dos Workers novos.

Exemplo de aviso:

> ❌ **Build Failed (Pages)**
> **maraba-agenda**
> [View Logs](#)
> **Branch:** `main` · **Commit:** `03cd820` · **Msg:** feat: adiciona notícia… · **Etapa:** build
> ```
> Failed: error occurred while running build command
> ```

---

## Implantar em uma nova conta Cloudflare

Faça os passos abaixo **uma vez em cada conta**. O código vem deste repositório, então todas as contas rodam a mesma versão.

> ⏱️ Leva uns 15 minutos. Tudo cabe no plano **gratuito** da Cloudflare.

### O que você precisa ter antes

- Acesso de administrador à conta Cloudflare.
- Uma conta do GitHub com acesso a `cadastrux/workers-builds-notifications-template` (a própria `cadastrux` ou um colaborador do repositório).
- A **URL do webhook do Discord** do canal de avisos (#erros-workers). Pode ser a mesma URL para todas as contas. Para criar uma: no Discord, abra **Editar canal → Integrações → Webhooks → Novo webhook → Copiar URL do webhook**.

### Passo 1: Criar a fila

1. No painel da Cloudflare: **Armazenamento e bancos de dados → Queues → Criar fila** (*Create queue*).
2. Nome: **`builds-event-subscriptions`** (exatamente este nome).
3. Clique em **Criar**.

> ⚠️ Crie a fila **antes** do passo 3. Sem ela o deploy do Worker falha.

### Passo 2: Criar o token de API

1. Clique no avatar (canto superior direito) → **Meu perfil → Tokens de API → Criar token → Criar token personalizado** (*Create Custom Token*).
   - Precisa ser um token de **usuário** (criado em *Meu perfil*). A API de builds recusa tokens de conta.
2. Nome: `Observador de builds - <nome da conta>`.
3. **Permissões**, todas do tipo **Conta** (*Account*):

   | Permissão | Nível | Para quê |
   |---|---|---|
   | Configuração de builds de Workers (*Workers Builds Configuration*) | Lido | ver se o Worker tem build pelo Git e ler logs |
   | Scripts do Workers (*Workers Scripts*) | Lido | listar os Workers da conta |
   | Queues | Editar | criar e atualizar as assinaturas de eventos |
   | Configurações da conta (*Account Settings*) | Lido | descobrir o ID da conta |
   | Cloudflare Pages | Lido | listar projetos Pages e ler logs de build |

4. **Recursos da conta** (*Account Resources*): **Incluir → a conta que você está configurando**.
   - Não use "Todas as contas" nas contas novas: veja [Avisos duplicados](#avisos-duplicados).
5. Sem expiração e sem filtro de IP. Clique em **Continuar → Criar token** e **copie o token** (ele só aparece uma vez).

### Passo 3: Importar o Worker do GitHub

1. **Workers e Pages → Criar → Importar um repositório** (*Import a repository*).
2. Conecte o GitHub (se for a primeira vez nesta conta) e escolha **`cadastrux/workers-builds-notifications-template`**.
3. Configuração:

   | Campo | Valor |
   |---|---|
   | Nome do projeto | `workers-builds-notifications-template` |
   | Comando da build | *(vazio)* |
   | Comando de implantação | `npm run deploy` |
   | Diretório raiz | `/` |
   | Ramificação de produção | `main` |

   > ⚠️ O nome do projeto precisa ser **exatamente** `workers-builds-notifications-template`, igual ao `name` do `wrangler.jsonc`. Com outro nome, a build falha.

4. Clique em **Criar e implantar**. Espere a build terminar com ✅.

O primeiro deploy cria sozinho:
- o **cron** a cada 5 minutos;
- a ligação com a fila `builds-event-subscriptions`;
- o armazenamento **KV `STATE`**, que guarda os IDs das mensagens para apagar depois.

### Passo 4: Configurar os segredos

No Worker: **Configurações → Variáveis e segredos → Adicionar**. Escolha o tipo **Segredo** (*Secret*), não texto simples, senão o valor some no próximo deploy.

| Nome | Valor |
|---|---|
| `SLACK_WEBHOOK_URL` | URL do webhook do Discord. Com ou sem `/slack` no final, tanto faz. |
| `CLOUDFLARE_API_TOKEN` | O token do passo 2. |
| `ACCOUNT_ID` | **Recomendado.** ID da conta: aparece na barra de endereço do painel, `dash.cloudflare.com/<ID>/...`, ou em **Visão geral da conta → ID da conta**. |

> O nome `SLACK_WEBHOOK_URL` vem do template original. Funciona normalmente com o Discord.

### Passo 5: Conferir

1. **Configurações → Eventos de gatilho**: precisa aparecer **Gatilhos cron: Every 5 minutes** e a fila **builds-event-subscriptions**.
2. **Configurações → Associações**: precisa aparecer **`STATE` (KV Namespace)**.
3. Espere a próxima execução (horários :00, :05, :10…) e abra **Observability**. Precisa aparecer:
   - `[pages] <id>: N projetos verificados, 0 falhas avisadas, 0 resolvidas.`
   - Nos minutos :00, :15, :30, :45 também: `[auto-subscribe] <id>: … já assinados, … novos`.
4. Em **Queues → builds-event-subscriptions → Assinaturas** vão aparecer as assinaturas `auto-<nome-do-worker>`, uma por Worker com build pelo Git.
   - Sites que são só **Pages** **não** aparecem aqui. Isso é normal, eles são vigiados pela consulta do cron.

### Passo 6: Testar

1. Em um site Pages da conta, provoque uma falha. Por exemplo, em **Configurações → Compilações**, troque o comando de build por `exit 1` e faça **Tentar implantar novamente**.
2. Em até 5 minutos chega a mensagem ❌ no Discord.
3. Desfaça a alteração e implante de novo. Quando a implantação terminar com sucesso, a mensagem **some do canal** em até 5 minutos.

---

## Atualizar o observador

Todas as contas importaram **o mesmo repositório**. Um `git push` na branch `main` atualiza o Worker de **todas as contas** de uma vez: cada conta roda a própria build.

Os segredos (`SLACK_WEBHOOK_URL`, `CLOUDFLARE_API_TOKEN`, `ACCOUNT_ID`) ficam em cada conta e **não** são afetados pelo deploy.

---

## Como funciona

```
Cloudflare Pages ──(cron 5 min: GET /pages/projects)──┐
                                                        ├─► Worker ─► Discord (envia / apaga)
Workers Builds ──(Event Subscription)──► Fila ─────────┘        │
                                                                 └─► KV STATE (id da mensagem por site)
```

- **Falha:** envia a mensagem com o erro extraído do log e guarda o ID dela no KV. Se o mesmo site falhar de novo, a mensagem antiga é trocada pela nova.
- **Sucesso depois de uma falha:** apaga a mensagem do Discord e remove do KV. Mensagens de sucesso não são enviadas. Para ativar, crie o **segredo** `NOTIFY_SUCCESS` = `true`. Como texto simples, ele some no próximo deploy.
- **Auto-assinatura (a cada 15 min):** para cada Worker com build pelo Git sem assinatura, cria uma com os eventos `build.failed` e `build.succeeded` na fila. Assinaturas antigas sem `build.succeeded` são atualizadas.

Arquivos principais:

| Arquivo | O que faz |
|---|---|
| `src/index.ts` | Agendamento (cron) e consumo da fila |
| `src/pages.ts` | Verificação das falhas do Pages |
| `src/subscriptions.ts` | Criação automática das assinaturas dos Workers |
| `src/state.ts` | Guarda e apaga os IDs das mensagens (KV) |
| `src/slack.ts` | Monta a mensagem e envia ao Discord (formato nativo) ou Slack |
| `wrangler.jsonc` | Cron, fila e KV |

### Limitações conhecidas

- **Pages:** só a **última** implantação de cada projeto é verificada. Se uma build falhar e outra for iniciada em menos de 5 minutos, a primeira falha pode não ser avisada.
- **Pages:** uma falha corrigida em menos de 5 minutos pode não gerar aviso. Isso não é problema, já está resolvida.
- **Workers novos:** entram na assinatura em até 15 minutos. Uma falha antes disso não é avisada.
- **Plano gratuito:** até 50 requisições por execução. Com muitos Workers sem Git, a auto-assinatura divide o trabalho entre execuções.

---

## Solução de problemas

Procure no **Observability** do Worker as linhas `[pages]`, `[auto-subscribe]`, `[state]` e `[cron]`.

| Mensagem no log | Causa | Solução |
|---|---|---|
| `[pages] Erro ao listar projetos (HTTP 403)` | Token sem **Cloudflare Pages: Lido** | Edite o token e adicione a permissão |
| `Falha ao assinar … (HTTP 401) Authentication error` | Token sem **Queues: Editar**, ou o segredo tem outro token | Confira as permissões e cole o token certo em `CLOUDFLARE_API_TOKEN` |
| `Erro ao ler build de … (HTTP 403)` | Token sem **Workers Builds Configuration: Lido** | Adicione a permissão |
| `Não consegui listar contas` | Token sem **Account Settings: Lido** | Adicione a permissão ou crie o segredo `ACCOUNT_ID` |
| `fila "builds-event-subscriptions" não existe` | Fila não criada ou com outro nome | Passo 1 |
| `Slack API error: 404` | Webhook do Discord apagado ou URL errada | Gere um novo webhook e atualize `SLACK_WEBHOOK_URL` |
| `[cron] CLOUDFLARE_API_TOKEN não configurado` | Segredo ausente | Passo 4 |
| Nenhuma linha `[pages]` | O cron ainda não rodou ou o deploy falhou | Confira **Eventos de gatilho** e a aba **Implantações** |

### Avisos duplicados

Se o mesmo erro chegar duas vezes no Discord, o token de uma conta tem acesso a **mais de uma conta**, e cada observador está vigiando as outras também.

**Solução:** crie o segredo **`ACCOUNT_ID`** em cada conta (passo 4) e/ou limite o token à própria conta (passo 2, item 4).

### O aviso não chegou

- A build do Pages pode levar até **5 minutos** depois de **terminar** para ser avisada. Confira o horário em que ela terminou, não o de início.
- Falhas que aconteceram **antes** do primeiro deploy do observador na conta não são avisadas.

---

## Desenvolvimento

```bash
npm ci
npm test        # testes (vitest + workers pool)
npx tsc --noEmit
```

O README original do template da Cloudflare está em [`docs/README-template-original.md`](docs/README-template-original.md).
