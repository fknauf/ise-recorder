import { PublicServerEnvironment } from "./lib";

export async function GET() {
    const env: PublicServerEnvironment = {
        api_url: process.env.ISE_RECORD_API_URL
    }

    return Response.json(env);
}
