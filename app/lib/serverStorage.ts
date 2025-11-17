export async function sendChunkToServer(
    chunk: Blob,
    recording: string,
    track: string,
    index: number
) {
    if(!process.env.NEXT_PUBLIC_API_URL) {
        return;
    }

    const chunkUrl = `${process.env.NEXT_PUBLIC_API_URL}/api/chunks`;

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
    if(!process.env.NEXT_PUBLIC_API_URL) {
        return;
    }

    const jobUrl = `${process.env.NEXT_PUBLIC_API_URL}/api/jobs`;

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
