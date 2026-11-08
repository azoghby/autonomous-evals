import { handleFixture } from '../../../fixture';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> { return handleFixture(request, 'buggy'); }
export async function GET(request: Request): Promise<Response> { return handleFixture(request, 'buggy'); }
export async function PUT(request: Request): Promise<Response> { return handleFixture(request, 'buggy'); }
export async function PATCH(request: Request): Promise<Response> { return handleFixture(request, 'buggy'); }
export async function DELETE(request: Request): Promise<Response> { return handleFixture(request, 'buggy'); }
export async function OPTIONS(request: Request): Promise<Response> { return handleFixture(request, 'buggy'); }
export async function HEAD(request: Request): Promise<Response> { return handleFixture(request, 'buggy'); }
