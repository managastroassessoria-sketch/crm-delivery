import { existsSync } from 'node:fs';
import { lerConfig } from '../src/config.ts';

// Carrega .env.local (sem dependências: API nativa do Node ≥ 22).
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
else console.log('Aviso: .env.local não encontrado; copie o .env.example.');

const { config, erros, avisos } = lerConfig();
const ok = (b: unknown) => (b ? 'configurado' : '—');
console.log(`Ambiente: ${config.ambiente} · fuso ${config.fuso}`);
console.log(`Banco: ${ok(config.databaseUrl)}`);
console.log(`WhatsApp: ${ok(config.whatsapp)}`);
console.log(`Anota AI: ${ok(config.anotaai)}`);
console.log(`Open Delivery: ${ok(config.openDelivery)}`);
for (const a of avisos) console.log(`Aviso: ${a}`);
for (const e of erros) console.log(`ERRO: ${e}`);
process.exitCode = erros.length ? 1 : 0;
