export async function readSetupJsonResponse<T>(
  response: Response,
  route: string,
): Promise<T> {
  const bodyText = await response.text();
  if (!bodyText.trim()) {
    throw new Error(
      `Setup request failed: ${route} returned HTTP ${response.status} with an empty response body`,
    );
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new Error(
      `Setup request failed: ${route} returned HTTP ${response.status} with an invalid JSON body`,
    );
  }
}
