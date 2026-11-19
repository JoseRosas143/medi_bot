import OpenAI from 'openai';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import type { KnowledgeCategory, MatchedKnowledge } from '@/types/database';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const EMBEDDING_MODEL = 'text-embedding-3-small';
const REASONING_MODEL = 'gpt-4o-mini';

/**
 * Genera un vector numérico de 1536 dimensiones a partir de un texto.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const cleanText = text.replace(/\s+/g, ' ').trim();

  if (!cleanText) {
    throw new Error('No se puede generar un embedding para un texto vacío.');
  }

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: cleanText,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      throw new Error('La API de embeddings no devolvió un vector válido.');
    }

    return embedding;
  } catch (error) {
    console.error('[Knowledge] Error generando embedding:', error);
    throw new Error('Fallo al vectorizar el texto con OpenAI.');
  }
}

/**
 * Busca los fragmentos activos más relevantes en Supabase usando similitud coseno.
 */
export async function searchKnowledge(
  query: string,
  matchCount = 4,
  matchThreshold = 0.45
): Promise<MatchedKnowledge[]> {
  try {
    const queryEmbedding = await generateEmbedding(query);

    const { data, error } = await supabase.rpc('match_knowledge', {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (error) {
      console.error('[Knowledge] Error en RPC match_knowledge:', error);
      throw new Error(`Error consultando base de conocimientos: ${error.message}`);
    }

    return (data as MatchedKnowledge[]) ?? [];
  } catch (error) {
    console.error('[Knowledge] Error en searchKnowledge:', error);
    throw error;
  }
}

/**
 * Evalúa mediante LLM si la nueva información contradice o reemplaza registros activos previos
 * para desactivarlos antes de insertar el nuevo dato.
 */
async function detectObsoleteKnowledgeIds(
  category: KnowledgeCategory,
  newInfo: string,
  candidates: MatchedKnowledge[]
): Promise<string[]> {
  if (candidates.length === 0) return [];

  try {
    const completion = await openai.chat.completions.create({
      model: REASONING_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Eres un auditor de base de conocimientos de una clínica.
Compararás una NUEVA INFORMACIÓN (categoría: "${category}") contra una lista de REGISTROS EXISTENTES.
Devuelve únicamente un JSON con el formato: { "obsolete_ids": ["uuid1", "uuid2"] }.
Reglas:
- Incluye un ID en "obsolete_ids" SOLO si la nueva información actualiza, reemplaza o contradice directamente ese dato (ej. cambio de precio de un mismo servicio, cambio de horario, nueva dirección o política).
- NO marques como obsoletos datos complementarios o de otros servicios distintos.
- Si ninguno entra en conflicto, devuelve { "obsolete_ids": [] }.`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            nueva_informacion: newInfo,
            registros_existentes: candidates.map((c) => ({
              id: c.id,
              category: c.category,
              content: c.content,
            })),
          }),
        },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content;
    if (!rawContent) return [];

    const parsed = JSON.parse(rawContent) as { obsolete_ids?: unknown };
    if (!Array.isArray(parsed.obsolete_ids)) return [];

    const validIds = new Set(candidates.map((c) => c.id));
    return parsed.obsolete_ids.filter(
      (id): id is string => typeof id === 'string' && validIds.has(id)
    );
  } catch (error) {
    console.error('[Knowledge] Error detectando registros obsoletos:', error);
    return [];
  }
}

/**
 * Vectoriza y guarda conocimiento nuevo en `knowledge_base`.
 * Si detecta registros previos que quedan obsoletos por la actualización, los desactiva (`is_active = false`).
 */
export async function updateKnowledge(
  category: KnowledgeCategory,
  newInfo: string
): Promise<{ insertedId: string; deactivatedCount: number }> {
  const cleanInfo = newInfo.trim();
  const newEmbedding = await generateEmbedding(cleanInfo);

  // 1. Buscar candidatos activos similares para detectar posibles contradicciones
  const { data: candidatesData } = await supabase.rpc('match_knowledge', {
    query_embedding: newEmbedding,
    match_threshold: 0.6,
    match_count: 5,
  });

  const candidates = (candidatesData as MatchedKnowledge[]) ?? [];
  const obsoleteIds = await detectObsoleteKnowledgeIds(category, cleanInfo, candidates);

  // 2. Desactivar registros obsoletos si existen
  if (obsoleteIds.length > 0) {
    const { error: deactivateError } = await supabase
      .from('knowledge_base')
      .update({ is_active: false })
      .in('id', obsoleteIds);

    if (deactivateError) {
      console.error('[Knowledge] Error desactivando registros obsoletos:', deactivateError);
    }
  }

  // 3. Insertar el nuevo registro activo
  const { data: inserted, error: insertError } = await supabase
    .from('knowledge_base')
    .insert({
      category,
      content: cleanInfo,
      embedding: newEmbedding,
      is_active: true,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    console.error('[Knowledge] Error insertando nuevo conocimiento:', insertError);
    throw new Error(`No se pudo guardar el conocimiento: ${insertError?.message}`);
  }

  return {
    insertedId: inserted.id as string,
    deactivatedCount: obsoleteIds.length,
  };
}