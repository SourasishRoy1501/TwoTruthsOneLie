import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/engine';
import { handleOp } from '@/lib/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const result = await handleOp(body);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status, headers: { 'Cache-Control': 'no-store' } });
    }
    console.error('[api/game] unexpected error', e);
    return NextResponse.json(
      { error: 'Something went wrong on our side. Retrying…' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
