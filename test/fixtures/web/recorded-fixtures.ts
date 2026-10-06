export const sampleArticleHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Understanding Modern Coding Agents</title>
</head>
<body>
  <header>
    <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
  </header>
  <main>
    <article>
      <h1>Understanding Modern Coding Agents</h1>
      <p class="byline">By Jane Doe</p>
      <div class="content">
        <p>Autonomous agents are changing software development.</p>
        <p>By leveraging structured tool calls, persistent memory, and deterministic verification gates, agents can deliver reliable software improvements unattended.</p>
      </div>
    </article>
  </main>
  <footer>
    <p>&copy; 2026 Tech Journal. All rights reserved.</p>
  </footer>
</body>
</html>`;

export const robotsTxtDisallowingSecret = `User-agent: *
Disallow: /admin
Disallow: /private/
Allow: /
`;

export const braveResponseFixture = {
  web: {
    results: [
      {
        title: 'Vitest Next Generation Testing',
        url: 'https://vitest.dev',
        description: 'Vitest is a blazing fast unit test framework powered by Vite.',
      },
      {
        title: 'Model Context Protocol',
        url: 'https://modelcontextprotocol.io',
        description: 'An open protocol that enables seamless integration between LLM apps and tools.',
      },
    ],
  },
};

export const tavilyResponseFixture = {
  results: [
    {
      title: 'Tavily Search API',
      url: 'https://tavily.com',
      content: 'Search API built for AI agents and LLMs.',
    },
  ],
};

export const exaResponseFixture = {
  results: [
    {
      title: 'Exa AI Search',
      url: 'https://exa.ai',
      text: 'Search engine designed from scratch for AI agents.',
    },
  ],
};

export const searxngResponseFixture = {
  results: [
    {
      title: 'SearXNG Metasearch Engine',
      url: 'https://searx.space',
      content: 'A privacy-respecting, hackable metasearch engine.',
    },
  ],
};
