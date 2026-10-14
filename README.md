# ARENA LIVE

Jogo de batalha 2D em tempo real, com lutadores e cenário em pixel art, controlado por comentários, curtidas e presentes de uma transmissão TikTok LIVE. O projeto inclui frontend Phaser 3, servidor Node.js/Socket.IO, painel administrativo autenticado e persistência SQLite.

## Requisitos

- Node.js 20.19 ou superior e npm.
- Uma máquina/serviço Node acessível pela internet para receber as conexões do navegador.
- Para eventos reais, um criador com uma transmissão TikTok LIVE pública e ativa.

## Instalação local

```sh
npm install
```

Copie `.env.example` para `.env` e configure uma senha exclusiva para o painel:

```dotenv
PORT=3000
NODE_ENV=development
ADMIN_PASSWORD=defina-uma-senha-longa-e-unica
COOKIE_SECURE=false
DATABASE_PATH=./data/arena-live.sqlite
```

Inicie o servidor:

```sh
npm start
```

Abra `http://localhost:3000`. A pasta `data/` e o banco SQLite são criados automaticamente. O painel fica no ícone de engrenagem. O usuário administrativo **não** tem uma senha padrão; sem `ADMIN_PASSWORD`, o login é desabilitado.

## Testar sem TikTok

Use **Iniciar demo**, **Comentário demo** e **Evento demo**. Esses controles geram ações de demonstração identificadas como tal e não alegam conexão com o TikTok nem enviam eventos para uma live. Também é possível escolher um lutador na página e usar os botões de ataque, defesa e especial. O jogo não precisa de uma transmissão ativa para esse modo.

## Conectar eventos de um TikTok LIVE

1. Publique uma transmissão pública e ativa na conta do criador.
2. Abra o painel com a senha administrativa.
3. Informe o nome público do criador (com ou sem `@`) e selecione **Conectar LIVE**.
4. Aguarde o indicador mudar para **LIVE conectado**. Em caso de falha, o painel e o indicador mostram que a conexão não está ativa.
5. Os nomes dos lutadores podem ser definidos no painel (por padrão, Lula × Bolsonaro). Ao conectar, a partida começa automaticamente; quando uma rodada termina, outra começa sozinha enquanto o TikTok LIVE continuar conectado. **Cada comentário** faz o espectador entrar automaticamente no lado menos populoso e atacar o lutador adversário. Para escolher um lado explicitamente, envie `!entrar Lula` ou `!entrar Bolsonaro` (use os nomes configurados). Os comandos `!atacar`, `!defender`, `!especial` e `!top` continuam disponíveis; curtidas alimentam a barra coletiva e presentes ativam habilidades configuráveis.

Se o conector responder que o usuário não está ao vivo, o painel informa que é necessário iniciar uma transmissão pública nessa conta antes de conectar. Uma conta offline não pode fornecer eventos de chat, mesmo que o nome esteja correto.

Cada lado tem uma barra de vida compartilhada por todos os seus apoiadores. O jogo mantém a lógica e a pontuação no servidor; ações do navegador são enviadas por Socket.IO e nomes/textos de espectadores são limitados e tratados como texto. Eventos reais do TikTok chegam ao servidor pelo conector, não por eventos enviados pelo navegador. Uma conexão LIVE desabilita os controles de evento de demonstração.

O adaptador suporta o formato de eventos atual do `tiktok-live-connector` 2.x e o formato legado: comentários usam o texto e o usuário do evento, curtidas usam a contagem recebida, e presentes em sequência só são aplicados quando a sequência termina.

### Importante sobre o TikTok

`tiktok-live-connector` é uma biblioteca comunitária **não oficial**, não afiliada ao TikTok/ByteDance. Ela obtém eventos de lives públicas via engenharia reversa do protocolo usado pelo serviço. **Não é uma API oficial do TikTok, não há garantia de estabilidade ou disponibilidade, e mudanças no serviço ou restrições regionais podem interromper a conexão.** Não são usados endpoints fictícios, credenciais da conta do criador, nem uma API oficial inexistente para ler comentários/gifts de uma conta comum. Uma conexão só é considerada ativa depois que o conector realmente completa a conexão; não use o modo DEMO como sinal de conexão TikTok.

## Painel e regras

O painel permite iniciar e encerrar partidas, escolher os dois nomes, configurar duração (30–900 s), capacidade (2–500 espectadores), meta coletiva de curtidas e regras por presente. No editor **Regras de presentes**, adicione uma linha para cada presente e configure seu nome como aparece no TikTok, efeito, intensidade (1–100) e rótulo mostrado na arena. É possível adicionar até 30 regras; nomes repetidos não são aceitos. Os efeitos são curar o time, carregar energia, causar dano ao rival ou proteger o time por 8 segundos. O cenário da batalha usa a imagem `public/assets/sprites/arena.png`, com os lutadores e efeitos do jogo desenhados por cima. Os eventos, configurações e placar geral são guardados em SQLite; a situação corrente da rodada vive na memória e volta ao estado de espera ao reiniciar o servidor.

## Publicação na internet

Este projeto precisa de um servidor Node.js: GitHub Pages publica arquivos estáticos e, portanto, **não executa** o servidor, as partidas compartilhadas, o Socket.IO ou a integração com TikTok LIVE. Enviar o código ao GitHub não o torna, por si só, um site funcionando.

1. Envie o repositório a uma hospedagem que execute aplicações Node.js e aceite conexões WebSocket.
2. Configure a versão mínima indicada em `engines` no `package.json`, instale com `npm ci --omit=dev` e use `npm start` como comando de inicialização. A aplicação escuta na porta fornecida pela variável de ambiente `PORT`.
3. Configure as variáveis de ambiente `NODE_ENV=production`, `ADMIN_PASSWORD` com uma senha longa e exclusiva e `COOKIE_SECURE=true`. Não publique o arquivo `.env` nem reutilize a senha do arquivo `.env.example`.
4. Configure `DATABASE_PATH` para um disco persistente fornecido pela hospedagem e faça cópias de segurança periódicas do SQLite. Um disco efêmero perde os dados quando o serviço reinicia ou é recriado.
5. Habilite HTTPS e o encaminhamento de WebSocket na hospedagem ou no proxy reverso. Socket.IO precisa que a conexão WebSocket seja preservada.
6. Compartilhe a URL HTTPS pública fornecida pela hospedagem.

Um processo ou disco efêmero não é adequado para o banco SQLite persistente. A disponibilidade do jogo público e da conexão externa ao TikTok depende do host, da rede e da transmissão de origem. Não exponha a porta administrativa sem HTTPS em produção.

## Segurança e limites

- Senha administrativa configurável, sessões aleatórias armazenadas como hash no SQLite, cookie HttpOnly/SameSite e expiração de 12 horas.
- Cabeçalhos Helmet/CSP, limites de tamanho/rate de requisição, validação das configurações e comandos de jogo limitados no servidor.
- O site não incorpora nem retransmite vídeo do TikTok: fornece o jogo interativo e a conexão ao fluxo de eventos. Use o player/ferramentas oficiais do TikTok para transmitir vídeo.
- Use apenas para lives às quais você tem autorização e siga os termos e políticas aplicáveis.
