"""Explicitly approved direct provider adapter; never routes via Emergent."""
import os


def approved_generator(inworld_completion):
    # Approval is an operator assertion, not evidence of provider retention.
    if (os.getenv('OLLENYA_PRIVATE_PROVIDER_APPROVED') != '1'
            or os.getenv('OLLENYA_LLM_PROVIDER', 'inworld').strip().lower() != 'inworld'
            or not os.getenv('INWORLD_API_KEY', '').strip()):
        return None

    async def generate(*, messages):
        # No cache controls, tools, search, or fallback.
        response = await inworld_completion(messages=messages, max_tokens=650,
                                            timeout=30, stream=False)
        return response.choices[0].message.content
    return generate
