# Navalha no Bigode — Roadmap
> Consolidado do jogo do "e se" (25/08/2026) + estudo competitivo dos 9 concorrentes.
> Regras da casa: nada de prova social inventada; features opcionais somem quando vazias;
> clientes finais das barbearias jamais viram leads nossos.

## 🥇 Rápidos e de alto retorno (atacar primeiro)
1. **Campo "observações" no agendamento** — coluna `notes` em bookings → 💬 no card do
   painel + linha na confirmação. ("quero degradê igual da última vez")
2. **Auto-cancelamento pelo cliente** — link "precisa cancelar?" na confirmação e no
   lembrete → página de confirmação (padrão /late/) → status cancelled + aviso ao
   barbeiro no WhatsApp + vaga entra na cascata.
3. **Botão "⚡ Liberei mais cedo" na agenda** — barbeiro terminou rápido, robô oferece
   antecipação ao próximo da fila (janela = agora → próximo horário fixo; a cascata já
   filtra quem não cabe e pula pro seguinte).
4. **Prazo inteligente na cascata** — oferta padrão 5 min COM fila atrás; último da fila
   ganha prazo estendido (até ~30 min antes da vaga); entrou agendamento novo atrás de
   oferta estendida → prazo volta a 5 min na hora.
5. **Linguagem neutra** — nome da pessoa nas mensagens do robô em vez de "o barbeiro";
   rótulos: "Painel da barbearia", "profissionais". (Barbeiras existem.)

## 🥈 Identidade da barbearia (pacote "página = mini-site")
6. **Bloco "Dados da barbearia" no painel — TUDO opcional** (preencheu aparece, vazio some):
   - **Endereço** → verso do cartão + confirmação do robô com link do Maps + página
   - **WhatsApp público** → cartão + botão "💬 Falar com a barbearia" na página +
     rodapé do lembrete + link "mandar foto de referência" pós-agendamento
   - **@ do Instagram** → cartão + ícone na página
7. **Logo da barbearia** — upload no painel (coluna `logo_url` já existe) → topo da
   página do cliente + arte do cartão.
8. **Galeria de trabalhos** — fotos com tag de serviço → galeria filtrável na página +
   fotos na etapa de escolha do serviço (foto vende ticket maior). Limite por plano
   (Solo 10 / Equipe 30 / Black ilimitado).
9. **Avaliações reais** — pós-"Concluído" o robô convida a avaliar (estrelas + comentário)
   VINCULADO ao agendamento concluído (fake impossível por design). Média ⭐ na primeira
   tela junto do botão Agendar (exibir a partir de 3 avaliações), últimos comentários,
   resposta do barbeiro (1 nível), ocultar ofensivos (inventar jamais). Avaliação 5⭐ →
   robô sugere "compartilha no Google?". Feed próprio estilo Instagram: NÃO (usar link
   "ver no Instagram" na foto).
10. **Caixinha Pix** — chave Pix opcional POR PROFISSIONAL → convite no obrigado
    pós-Concluído → página com R$5/R$10/outro + QR Pix estático direto na conta do
    profissional (sem intermediação nossa, sem taxa).

## 🥉 Comercial / operação
11. **Cartões em todos os planos: 100/300/500** ("100 por barbeiro") — Solo passa a levar
    cartão (hoje não leva e é nosso diferencial mais único). Atualizar landing, cadastro,
    FAQ. ⚠️ Antes: conferir custo de gráfica da remessa de 500 (Black).
12. **Botão ❓ Ajuda no painel** — wa.me do suporte com barbearia/plano pré-preenchidos +
    mini-FAQ do barbeiro (horários, fechar dia, cancelar, cartões, mensalidade, divulgar).
13. **Aba 🎯 Leads no admin** — agendamentos da DEMO (donos de barbearia interessados) +
    cadastros abandonados (owner_phone sem ativação), com wa.me de follow-up em 1 toque.
    Linha vermelha: clientes finais das barbearias NUNCA.
14. **Multi-serviço no agendamento** — seleção múltipla, soma tempo+preço, bloqueia a
    janela total. Enquanto não sai: orientar barbeiros a cadastrar combos ("Corte+Barba").
15. **Agendamento recorrente** — cliente fixo "toda quinta às 19h" (roubado do Barbeiro
    Agenda; fideliza e enche agenda previsível).

## 📌 Já anotados antes do jogo (continuam valendo)
- **Pix-sinal anti-falta** (infra MP pronta) · **Aniversário do cliente final** (mimo
  automático) · **Migração grátis** (frase na landing) · **Antes/depois na landing** ·
  **Páginas /vs/** (AppBarber, BestBarbers…) + FAQPage schema · **Microsoft Clarity** ·
  **Resgate de sumido** (30+ dias sem voltar) · **Linha "R$ gerados pelo robô" no
  relatório semanal** · **Clube de assinaturas** (fase 2 — os líderes cobram caro por
  isso e barbearia paga anúncio pra vender assinatura, vide Barbearia Ferrero).

## Feito hoje (25/08) — pra não esquecer o quanto andou
Seção "diferencial do robô" + garantia 30 dias na landing · negativas no Ads · demo
"Barbearia do Léo" · convite em 2 tempos com código de USO ÚNICO · cadastro com teste de
10 dias self-service · botão Convidar no admin · destaque TESTE nos cards · linha de
saúde + detalhamento de agendamentos por cliente · Trocar e-mail (com reenvio de
boas-vindas) · "Tá chegando?" com timeout em cascata · pedido de cartões com Pix ·
remarcação de verdade (trocar ou manter os dois).
