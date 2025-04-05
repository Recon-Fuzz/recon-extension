export async function proxyRequest(method: string, endpoint: string, token?: string, data?: any): Promise<Response> {
    const response = await fetch('https://staging.getrecon.xyz/api/proxy', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            method,
            endpoint,
            token,
            data
        })
    });

    if (!response.ok) {
        throw new Error(`Proxy request failed: ${response.statusText}`);
    }

    return response;
}
