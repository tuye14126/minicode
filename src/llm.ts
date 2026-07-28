import OpenAI from 'openai';


export async function callAI(
  client: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): Promise<string | null> {
  const completion = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: messages
  });

  return completion.choices[0].message.content

}