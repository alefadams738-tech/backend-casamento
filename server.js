require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuração do Asaas
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_URL = process.env.ASAAS_URL || 'https://sandbox.asaas.com/api/v3';

// Middlewares
app.use(cors());
app.use(express.json());

// Gerador de CPF válido em tempo de execução para testes em Sandbox
function gerarCpfValido() {
  const rand = (n) => Math.floor(Math.random() * n);
  const n = Array.from({ length: 9 }, () => rand(10));
  
  let d1 = n.reduce((total, el, i) => total + el * (10 - i), 0);
  d1 = 11 - (d1 % 11);
  if (d1 >= 10) d1 = 0;
  
  let d2 = n.reduce((total, el, i) => total + el * (11 - i), 0) + d1 * 2;
  d2 = 11 - (d2 % 11);
  if (d2 >= 10) d2 = 0;
  
  return [...n, d1, d2].join('');
}

// Rota de Teste
app.get('/', (req, res) => {
  res.send('Servidor do Casamento Natasha & Alef está rodando! 💍✨');
});

// ==========================================
// ROTA 1: Criar/Gerar o PIX no Asaas
// ==========================================
app.post('/api/gerar-pix', async (req, res) => {
  try {
    const body = req.body || {};

    const presenteId = body.presenteId || body.idPresente || body.id || body.titulo;
    const nome = body.nome || body.comprador || body.nomeComprador || body.guestName;
    const mensagem = body.mensagem || body.compradorMensagem || '';
    let valor = body.valor || body.price;

    if (typeof valor === 'string') {
      valor = parseFloat(valor.replace('R$', '').replace('.', '').replace(',', '.').trim());
    }

    console.log(`\n⏳ Criando cobrança no Asaas...`);
    console.log(`   - Identificador Presente: ${presenteId} | Nome: ${nome} | Valor: R$ ${valor}`);

    if (!presenteId || !nome || !valor || isNaN(valor)) {
      return res.status(400).json({ error: 'Dados incompletos enviados ao servidor.' });
    }

    const cpfGerado = gerarCpfValido();

    // 1. Criar Cliente no Asaas
    const responseCliente = await fetch(`${ASAAS_URL}/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY
      },
      body: JSON.stringify({
        name: nome,
        cpfCnpj: cpfGerado,
        notificationDisabled: true
      })
    });

    const clienteData = await responseCliente.json();

    if (clienteData.errors) {
      console.error('❌ Erro Asaas (Criar Cliente):', clienteData.errors);
      return res.status(400).json({ error: clienteData.errors[0].description });
    }

    // 2. Criar Cobrança Pix no Asaas
    const responseCobranca = await fetch(`${ASAAS_URL}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY
      },
      body: JSON.stringify({
        customer: clienteData.id,
        billingType: 'PIX',
        value: valor,
        dueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        description: `Presente: ${presenteId} - De: ${nome}`,
        externalReference: presenteId.toString()
      })
    });

    const cobrancaData = await responseCobranca.json();

    if (cobrancaData.errors) {
      console.error('❌ Erro Asaas (Criar Cobrança):', cobrancaData.errors);
      return res.status(400).json({ error: cobrancaData.errors[0].description });
    }

    // 3. Buscar QR Code Pix da Cobrança Gerada
    const responsePix = await fetch(`${ASAAS_URL}/payments/${cobrancaData.id}/pixQrCode`, {
      headers: {
        'access_token': ASAAS_API_KEY
      }
    });

    const pixData = await responsePix.json();

    console.log(`✅ Cobrança criada com SUCESSO no Asaas! ID: ${cobrancaData.id}`);

    return res.json({
      cobrancaId: cobrancaData.id,
      qrCodeBase64: pixData.encodedImage,
      copiaECola: pixData.payload
    });

  } catch (error) {
    console.error('❌ Erro interno no servidor:', error);
    return res.status(500).json({ error: 'Erro de conexão com o Asaas.' });
  }
});

// ==========================================
// ROTA 2: Webhook do Asaas (Atualização no Supabase)
// ==========================================
app.post('/api/webhook-asaas', async (req, res) => {
  // Responde imediatamente com 200 OK para o Asaas não dar Timeout (408)
  res.status(200).send('OK');

  try {
    const { event, payment } = req.body || {};

    console.log(`\n🔔 Webhook recebido do Asaas! Evento: ${event}`);

    if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
      const presenteRef = payment?.externalReference;
      
      let nomeComprador = 'Convidado';
      if (payment?.description && payment.description.includes('De: ')) {
        nomeComprador = payment.description.split('De: ')[1].trim();
      } else if (payment?.customerName) {
        nomeComprador = payment.customerName;
      }

      console.log(`💳 Confirmação de PIX: Ref ${presenteRef} | Comprador: ${nomeComprador}`);

      if (presenteRef) {
        // Tenta atualizar primeiro pelo ID, se não for número tenta pelo TÍTULO
        const isNumeric = !isNaN(presenteRef);
        
        let query = supabase.from('presentes').update({
          status: 'PRESENTEADO',
          comprador_nome: nomeComprador
        });

        if (isNumeric) {
          query = query.eq('id', Number(presenteRef));
        } else {
          query = query.eq('titulo', presenteRef);
        }

        const { data, error } = await query;

        if (error) {
          console.error('❌ Erro ao atualizar Supabase:', error.message);
        } else {
          console.log(`🎉 Presente (${presenteRef}) atualizado para PRESENTEADO no Supabase!`);
        }
      }
    }
  } catch (err) {
    console.error('❌ Erro no processamento do Webhook:', err);
  }
});

const ngrok = require('@ngrok/ngrok');

app.listen(PORT, async () => {
  console.log(`🚀 Servidor local rodando na porta ${PORT}`);

  try {
    const listener = await ngrok.forward({
      addr: PORT,
      authtoken: '3I8td97SZmG33CaEBmLSELah3AM_35U1wGEpV7ewhi36LoTaL',
      domain: 'drainable-tantrum-enclosure.ngrok-free.dev'
    });

    console.log(`🌐 Tunnel do ngrok ATIVO e FIXO em: ${listener.url()}`);
  } catch (err) {
    console.error('❌ Erro ao iniciar o ngrok:', err);
  }
});