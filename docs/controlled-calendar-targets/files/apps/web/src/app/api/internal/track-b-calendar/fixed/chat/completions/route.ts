import { handleFixture } from '../../../fixture';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> { return handleFixture(request, 'fixed'); }
export async function GET(request: Request): Promise<Response> { return handleFixture(request, 'fixed'); }
export async function PUT(request: Request): Promise<Response> { return handleFixture(request, 'fixed'); }
export async function PATCH(request: Request): Promise<Response> { return handleFixture(request, 'fixed'); }
export async function DELETE(request: Request): Promise<Response> { return handleFixture(request, 'fixed'); }
export async function OPTIONS(request: Request): Promise<Response> { return handleFixture(request, 'fixed'); }
export async function HEAD(request: Request): Promise<Response> { return handleFixture(request, 'fixed'); }
