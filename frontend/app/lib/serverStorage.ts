import { clientGetPublicServerEnvironment, PublicServerEnvironment } from "../env/lib";

async function getApiUrl(): Promise<string | undefined> {
    const env = await clientGetPublicServerEnvironment();
    return env.api_url;
}

export async function sendChunkToServer(
    chunk: Blob,
    recording: string,
    track: string,
    index: number
) {
    const api_url = await getApiUrl();

    if(!api_url) {
        return;
    }

    const chunkUrl = `${api_url}/api/chunks`;

    const retries = 5;
    const intervalMillis = 2000;

    const data = new FormData();

    data.append('recording', recording);
    data.append('track', track);
    data.append('index', index.toFixed(0));
    data.append('chunk', chunk);

    for(let attempt = 0; attempt < retries; ++attempt) {
        try {
            await fetch(chunkUrl, {
                method: "POST",
                body: data
            });
            break;
        } catch(e) {
            console.log(e);
            await new Promise(resolve => setTimeout(resolve, intervalMillis));
        }
    }
}

export async function scheduleRenderingJob(
    recording: string,
    title: string,
    recipient?: string
) {
    const api_url = await getApiUrl();

    if(!api_url) {
        return;
    }

    const jobUrl = `${api_url}/api/jobs`;

    try {
        const data = {
            title,
            recording,
            recipient
        };

        await fetch(jobUrl, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });
    } catch(e) {
        console.log(e);
    }
}
