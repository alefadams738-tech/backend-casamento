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

// Configuração do Asaas (Produção)
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_URL = process.env.ASAAS_URL || 'https://www.asaas.com/api/v3';

// Middlewares
app.use(cors());
app.use(express.json());

// Rota de Teste
app.get('/', (req, res) => {
  res.send('Servidor do Casamento Natasha & Alef está rodando! 💍✨');
});

// ==========================================
// ROTA 1: Criar/Gerar o PIX no Asaas (PRODUÇÃO)
// ==========================================
app.post('/api/gerar-pix', async (req, res) => {
  try {
    const body = req.body || {};

    const presenteId = body.presenteId || body.idPresente || body.id || body.titulo;
    const nome = body.nome || body.comprador || body.nomeComprador || body.guestName;
    const cpfComprador = body.cpf || body.cpfComprador || body.cpfCnpj || '00000000000'; // Usa o informado no site ou valor padrão
    let valor = body.valor || body.price;

    if (typeof valor === 'string') {
      valor = parseFloat(valor.replace('R$', '').replace('.', '').replace(',', '.').trim());
    }

    console.log(`\n⏳ Criando cobrança no Asaas (Produção)...`);
    console.log(`   - Identificador Presente: ${presenteId} | Nome: ${nome} | Valor: R$ ${valor}`);

    if (!presenteId || !nome || !valor || isNaN(valor)) {
      return res.status(400).json({ error: 'Dados incompletos enviados ao servidor.' });
    }

    // 1. Criar Cliente no Asaas (Com CPF para aprovação imediata no Banco Central)
    const responseCliente = await fetch(`${ASAAS_URL}/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': ASAAS_API_KEY
      },
      body: JSON.stringify({
        name: nome,
        cpfCnpj: cpfComprador.replace(/\D/g, ''), // Envia apenas os números do CPF
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

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
