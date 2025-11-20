export interface PublicServerEnvironment {
    api_url: string | undefined
};

export async function clientGetPublicServerEnvironment(): Promise<PublicServerEnvironment> {
    const response = await fetch("env");
    const env = await response.json();

    if(typeof env.api_url !== 'string')
        env.api_url = undefined

    return env as PublicServerEnvironment;
}
