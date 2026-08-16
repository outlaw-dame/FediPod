// assistant-tools.mjs — function tool(s) the compose assistant chat can call
// (see ai.mjs/gemini.mjs's assistantReply and mastoapi.mjs's
// /api/v1/ailo/ai/assistant/chat). Shared so the same name/description/
// schema reaches both providers identically — drift here would mean one
// provider recognizes "draft me a feed" as a request to act on and the
// other just talks about it.
export const DRAFT_CUSTOM_FEED_TOOL = {
  name: 'draft_custom_feed',
  description: 'Draft a custom Fediverse feed (name, description, accounts to include, hashtags, semantic '
    + 'topic keywords, and exclusions) from what the user describes wanting to see. Call this whenever the '
    + 'user asks to create, draft, build, or set up a custom feed — do not just describe what a feed would '
    + 'look like in text.',
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'A concise restatement of what the user wants this feed to contain, in their own words.',
      },
    },
    required: ['request'],
  },
};
