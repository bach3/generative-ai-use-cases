import useChat from './useChat';
import useChatApi from './useChatApi';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fetchAuthSession } from 'aws-amplify/auth';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { StreamingChunk, McpRequest } from 'generative-ai-use-cases';

const MCP_ENDPOINT = import.meta.env.VITE_APP_MCP_ENDPOINT;

const useMcpApi = (id: string) => {
  const {
    loading,
    setLoading,
    pushMessage,
    createChatIfNotExist,
    addChunkToAssistantMessage,
    addMessageIdsToUnrecordedMessages,
    replaceMessages,
    setPredictedTitle,
  } = useChat(id);

  const { createMessages } = useChatApi();

  const processChunk = (chunk: string) => {
    const streamingChunk: StreamingChunk = JSON.parse(chunk);
    addChunkToAssistantMessage(streamingChunk.text, streamingChunk.trace);
  };

  const postMessage = async (req: McpRequest) => {
    setLoading(true);

    try {
      pushMessage('user', req.userPrompt);
      pushMessage('assistant', '');

      const url = new URL(MCP_ENDPOINT);
      const hostname = url.hostname;
      const pathname = url.pathname;

      const request = new HttpRequest({
        hostname,
        path: pathname,
        method: 'POST',
        headers: {
          host: hostname,
          'content-type': 'application/json',
        },
        body: JSON.stringify(req),
      });

      const token = (await fetchAuthSession()).tokens?.idToken?.toString();

      if (!token) {
        throw new Error('Not authenticated');
      }

      const region = import.meta.env.VITE_APP_REGION;
      const userPoolId = import.meta.env.VITE_APP_USER_POOL_ID;
      const idPoolId = import.meta.env.VITE_APP_IDENTITY_POOL_ID;
      const cognito = new CognitoIdentityClient({ region });
      const providerName = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
      const credentialProvider = fromCognitoIdentityPool({
        client: cognito,
        identityPoolId: idPoolId,
        logins: {
          [providerName]: token,
        },
      });
      const credentials = await credentialProvider();

      const signer = new SignatureV4({
        credentials,
        region,
        service: 'lambda',
        sha256: Sha256,
      });

      const signedRequest = await signer.sign(request);
      const response = await fetch(MCP_ENDPOINT, {
        method: signedRequest.method,
        headers: signedRequest.headers,
        body: JSON.stringify(req),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Failed to start mcp streaming: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            processChunk(line);
          }
        }

        if (done && buffer) {
          processChunk(buffer);
        }

        if (done) {
          break;
        }
      }

      const chatId = await createChatIfNotExist();
      await setPredictedTitle();
      const toBeRecordedMessages = addMessageIdsToUnrecordedMessages();
      const { messages } = await createMessages(chatId, {
        messages: toBeRecordedMessages,
      });
      replaceMessages(messages);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    postMessage,
  };
};

export default useMcpApi;
