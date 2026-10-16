# Alerta de Estoque: envio automático (VPS)

Esta rotina roda na VPS, fora do Sankhya, e faz o seguinte:

1. Lê os cadastros do Monitor de Estoque e o estoque (TGFEST) pelo **Sankhya API Gateway**.
2. Calcula o disponível de cada grupo com a mesma regra da tela.
3. Para cada grupo **crítico**, envia o e-mail pelo **Resend**.
4. Grava o resultado na **AD_ALERLOG**, que aparece na página Histórico da tela.

## Regra de envio

- Só grupos **ativos** com **E-mail ativo = S** e pelo menos um destinatário ativo.
- **Destinatários:** os do próprio grupo, mais os cadastrados sem grupo ("Todos os grupos"). Endereços repetidos ou inválidos são ignorados.
- **Frequência:** **um e-mail por dia por grupo enquanto continuar crítico.** A chave do evento é `G<ID do grupo>-<AAAAMMDD>`.
  - Se já existir um envio com STATUS **E** com essa chave, o grupo não recebe outro e-mail no mesmo dia.
  - Quando o grupo sai do crítico, os e-mails param.
- **AD_ALERLOG:** o status passa por **R** (processando), depois **E** (enviado, com o ID do Resend) ou **F** (falha, com o erro). Depois de uma falha, a próxima execução do mesmo dia tenta de novo e atualiza a mesma linha.
- **Tabelas nativas:** a rotina só **lê** TGFEST, TGFPRO e TSIEMP. A única gravação é na AD_ALERLOG.

## 1. Resend

1. Em **resend.com › Domains**, adicione `brasmaquinas.com.br`. Cadastre no DNS do domínio os registros mostrados (SPF/MX do subdomínio `send` e DKIM `resend._domainkey`). Aguarde o status **Verified**.
   - Sem o domínio verificado, o Resend só envia para o e-mail dono da conta.
   - Se o domínio já tiver um registro SPF, siga o que o Resend indicar sem criar um segundo registro SPF na raiz.
2. Em **API Keys**, crie uma chave com permissão **Sending access**, restrita ao domínio `brasmaquinas.com.br`.
3. O remetente configurado é `ti.gbi@brasmaquinas.com.br`.

## 2. Sankhya API Gateway

O padrão é a autenticação **OAuth** (`"autenticacao": "oauth"`), que usa três dados:

- **X-Token:** o token do Gateway, no campo `token`;
- **Client ID:** no campo `clientId`;
- **Client Secret:** no campo `clientSecret`.

Esses dados vêm da área do desenvolvedor / Sankhya Place, na aplicação cadastrada para a Brasmáquinas.

Se a aplicação de vocês usa o **login antigo** (token + appkey + usuário + senha), configure `"autenticacao": "legado"` e preencha `token`, `appkey`, `usuario` e `senha`.

O usuário da integração precisa de:

- **leitura** em AD_ALERGRUPO, AD_ALERPROD, AD_ALERDEST, AD_ALERLOCAL, Produto, Estoque e Empresa;
- **inclusão e alteração** em AD_ALERLOG.

## 3. Instalação no Easypanel (recomendado)

A rotina roda como um **Aplicativo** que fica ligado. Ela tem agenda própria (variável `AGENDA_HORAS`), então não precisa de cron. Não tem porta nem domínio.

1. **Repositório:** suba esta pasta (`alerta.js`, `Dockerfile`, `.dockerignore`, `README.md`, `config.exemplo.json`) para um repositório **privado** no GitHub, ex.: `brasmaquinas/alerta-estoque`.
2. **Criar o serviço:** no projeto `brasmaquinas-com-br`, clique em **+ Serviço › Aplicativo** e dê o nome `alerta-estoque`.
3. **Fonte:** escolha **GitHub**, selecione o repositório e a branch `main`. Em **Construção**, escolha **Dockerfile** (arquivo `Dockerfile`).
4. **Ambiente:** cole as variáveis e troque os valores:

```
SANKHYA_TOKEN=token-do-api-gateway
SANKHYA_CLIENT_ID=client-id
SANKHYA_CLIENT_SECRET=client-secret
RESEND_API_KEY=re_xxxxxxxx
RESEND_REMETENTE=Monitor de Estoque <ti.gbi@brasmaquinas.com.br>
RESEND_RESPONDER_PARA=ti.gbi@brasmaquinas.com.br
AGENDA_HORAS=7,9,11,13,15,17,19
AGENDA_DIAS=1,2,3,4,5,6
```

   - **Login antigo do Gateway:** acrescente `SANKHYA_AUTENTICACAO=legado`, `SANKHYA_APPKEY`, `SANKHYA_USUARIO` e `SANKHYA_SENHA`, no lugar do client id/secret.
   - **Regra de cálculo:** só precisa mudar se a tela não estiver no padrão. Use `EMPRESAS_PARTICIPANTES=1,2`, `SOMENTE_ESTOQUE_PROPRIO=N` e `FAIXA_ATENCAO_PCT=20`, iguais ao `config.js` da tela.

5. **Implantar:** clique em **Implantar**. Na aba **Logs** deve aparecer `Serviço iniciado. Horários: 7, 9, 11...`. Se faltar alguma variável, o log diz qual.
6. **Testar:** pela aba **Console** do serviço:
   - `node alerta.js --teste`: calcula e mostra os números, sem enviar nem gravar;
   - `node alerta.js --para ti.gbi@brasmaquinas.com.br`: envia o e-mail só para você.

Em cada horário da agenda, a rotina roda uma vez. Se o serviço reiniciar dentro de um horário da agenda, ele roda de novo, mas o controle da AD_ALERLOG impede um segundo e-mail no mesmo dia.

## 3b. Instalação direta em VPS Linux (sem Easypanel)


Requer **Node.js 18 ou mais novo**. Confira com `node -v`. A rotina não tem dependências, então não é preciso rodar `npm install`.

```bash
sudo mkdir -p /opt/alerta-estoque
sudo cp alerta.js config.exemplo.json /opt/alerta-estoque/
cd /opt/alerta-estoque
sudo cp config.exemplo.json config.json
sudo nano config.json            # preencha token, client id/secret e a chave do Resend
sudo chmod 600 config.json       # só o dono lê (contém segredos)
```

Os segredos também podem vir de variáveis de ambiente, que têm prioridade sobre o arquivo: `SANKHYA_TOKEN`, `SANKHYA_CLIENT_ID`, `SANKHYA_CLIENT_SECRET` e `RESEND_API_KEY`.

### Testar antes de agendar

```bash
node alerta.js --teste
```

Calcula os grupos, mostra o disponível de cada um e gera `previa-email.html`. Não envia e não grava nada. Confira se os números batem com a página Conferência da tela.

```bash
node alerta.js --para ti.gbi@brasmaquinas.com.br
```

Envia o e-mail dos grupos críticos **só para o endereço informado**, sem gravar no histórico. Use para validar o Resend.

### Agendar a cada 2 horas (cron)

```bash
sudo crontab -e
```

```
# Alerta de estoque: a cada 2 horas, das 7h às 19h, de segunda a sábado (horário de Brasília)
CRON_TZ=America/Sao_Paulo
0 7-19/2 * * 1-6 cd /opt/alerta-estoque && /usr/bin/node alerta.js >> /var/log/alerta-estoque.log 2>&1
```

Ajuste o caminho do `node` com `which node`. O primeiro horário do dia em que o grupo estiver crítico dispara o e-mail; os demais horários só confirmam que o e-mail já foi enviado.

### VPS Windows

Use o Agendador de Tarefas com uma tarefa que roda a cada 2 horas:

- **Programa:** `C:\Program Files\nodejs\node.exe`
- **Argumentos:** `alerta.js`
- **Iniciar em:** a pasta da rotina

## 4. Acompanhamento

- **Log da execução:** aba **Logs** do serviço no Easypanel (ou `/var/log/alerta-estoque.log` na instalação com cron). Mostra o disponível de cada grupo e o que foi enviado.
- **Na tela:** a página **Histórico** do Monitor de Estoque lista cada envio com a chave do evento (grupo e data), o status, o ID no Resend e o erro, quando houver.
- **Código de saída:**
  - 0: tudo certo;
  - 1: erro geral, como falha de login ou de leitura;
  - 2: algum envio falhou.

## Configuração da regra

O bloco `regra` do `config.json` (`empresasParticipantes`, `somenteEstoqueProprio`, `faixaAtencaoPct`) deve ficar **igual ao `config.js` da tela**, para o e-mail e a tela mostrarem o mesmo número.
