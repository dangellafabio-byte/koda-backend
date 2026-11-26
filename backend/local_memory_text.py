"""Text-only device memory ingress. Call inside the existing authenticated quota flow."""
import json

from local_memory_generation import build_private_messages


async def private_text_reply(text, context, system_prompt, completion, token_limit):
    if context == '[]':
        messages = [{'role': 'system', 'content': system_prompt}, {'role': 'user', 'content': text}]
    else:
        messages = build_private_messages(system_prompt, text, context)
    result = await completion(messages=messages, max_tokens=token_limit, timeout=25, stream=False)
    data = json.loads(result.choices[0].message.content)
    reply = data.get('reply') if isinstance(data, dict) else None
    if not isinstance(reply, str) or not reply.strip():
        raise ValueError('Invalid conversation response')
    return reply.strip()
