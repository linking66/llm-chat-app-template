/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const modelSelect = document.getElementById("model-select");

// Chat state
let chatHistory = [
	{
		role: "assistant",
		content:
			"Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
	},
];
let isProcessing = false;

// 初始化：为现有的所有 assistant 消息添加复制按钮
document.addEventListener("DOMContentLoaded", () => {
	document.querySelectorAll(".assistant-message").forEach((msgEl) => {
		const textEl = msgEl.querySelector("p");
		if (textEl && !msgEl.querySelector(".copy-btn")) {
			addCopyButtonToMessage(msgEl, textEl);
		}
	});
});

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Send message on Shift + Enter (Shift+Enter 发送，单独 Enter 换行)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * 为指定的消息元素添加复制按钮
 * @param {HTMLElement} messageEl - 消息容器（应具有 .assistant-message 类）
 * @param {HTMLElement} textEl - 包含文本的 <p> 元素
 */
function addCopyButtonToMessage(messageEl, textEl) {
	const copyBtn = document.createElement("button");
	copyBtn.className = "copy-btn";
	copyBtn.textContent = "复制";
	copyBtn.setAttribute("aria-label", "复制消息");
	
	copyBtn.addEventListener("click", async () => {
		const text = textEl.textContent; // 获取当前文本（流式更新时也是最新的）
		await copyToClipboard(text, copyBtn);
	});
	
	messageEl.appendChild(copyBtn);
}

/**
 * 复制文本到剪贴板，并临时改变按钮状态
 * @param {string} text - 要复制的文本
 * @param {HTMLElement} btn - 被点击的复制按钮
 */
async function copyToClipboard(text, btn) {
	try {
		await navigator.clipboard.writeText(text);
		showCopyFeedback(btn);
	} catch (err) {
		console.error('复制失败（使用备用方法）:', err);
		// 降级方案
		const textarea = document.createElement('textarea');
		textarea.value = text;
		document.body.appendChild(textarea);
		textarea.select();
		document.execCommand('copy');
		document.body.removeChild(textarea);
		showCopyFeedback(btn);
	}
}

function showCopyFeedback(btn) {
	const originalText = btn.textContent;
	btn.textContent = "已复制";
	btn.classList.add("copied");
	setTimeout(() => {
		btn.textContent = originalText;
		btn.classList.remove("copied");
	}, 2000);
}

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
	const message = userInput.value.trim();

	// Don't send empty messages
	if (message === "" || isProcessing) return;

	// Disable input and model selector while processing
	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;
	modelSelect.disabled = true;

	// Add user message to chat
	addMessageToChat("user", message);

	// Clear input
	userInput.value = "";
	userInput.style.height = "auto";

	// Show typing indicator
	typingIndicator.classList.add("visible");

	// Add message to history
	chatHistory.push({ role: "user", content: message });

	try {
		// Create new assistant response element
		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		assistantMessageEl.innerHTML = "<p></p>";
		chatMessages.appendChild(assistantMessageEl);
		const assistantTextEl = assistantMessageEl.querySelector("p");

		// 添加复制按钮
		addCopyButtonToMessage(assistantMessageEl, assistantTextEl);

		// Scroll to bottom
		chatMessages.scrollTop = chatMessages.scrollHeight;

		// Send request to API, including selected model
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: chatHistory,
				model: modelSelect.value,
			}),
		});

		// Handle errors
		if (!response.ok) {
			throw new Error("Failed to get response");
		}
		if (!response.body) {
			throw new Error("Response body is null");
		}

		// Process streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";
		const flushAssistantText = () => {
			assistantTextEl.textContent = responseText;
			chatMessages.scrollTop = chatMessages.scrollHeight;
		};

		let sawDone = false;
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				// Process any remaining complete events in buffer
				const parsed = consumeSseEvents(buffer + "\n\n");
				for (const data of parsed.events) {
					if (data === "[DONE]") {
						break;
					}
					try {
						const jsonData = JSON.parse(data);
						// Handle both Workers AI format (response) and OpenAI format (choices[0].delta.content)
						let content = "";
						if (
							typeof jsonData.response === "string" &&
							jsonData.response.length > 0
						) {
							content = jsonData.response;
						} else if (jsonData.choices?.[0]?.delta?.content) {
							content = jsonData.choices[0].delta.content;
						}
						if (content) {
							responseText += content;
							flushAssistantText();
						}
					} catch (e) {
						console.error("Error parsing SSE data as JSON:", e, data);
					}
				}
				break;
			}

			// Decode chunk
			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;
			for (const data of parsed.events) {
				if (data === "[DONE]") {
					sawDone = true;
					buffer = "";
					break;
				}
				try {
					const jsonData = JSON.parse(data);
					let content = "";
					if (
						typeof jsonData.response === "string" &&
						jsonData.response.length > 0
					) {
						content = jsonData.response;
					} else if (jsonData.choices?.[0]?.delta?.content) {
						content = jsonData.choices[0].delta.content;
					}
					if (content) {
						responseText += content;
						flushAssistantText();
					}
				} catch (e) {
					console.error("Error parsing SSE data as JSON:", e, data);
				}
			}
			if (sawDone) {
				break;
			}
		}

		// Add completed response to chat history
		if (responseText.length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
		}
	} catch (error) {
		console.error("Error:", error);
		addMessageToChat(
			"assistant",
			"Sorry, there was an error processing your request.",
		);
	} finally {
		// Hide typing indicator
		typingIndicator.classList.remove("visible");

		// Re-enable input and model selector
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		modelSelect.disabled = false;
		userInput.focus();
	}
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	messageEl.innerHTML = `<p>${content}</p>`;
	chatMessages.appendChild(messageEl);

	// 如果是 assistant 消息，添加复制按钮（此函数仅用于用户消息或错误消息，所以不处理）
	// 如果将来需要，可在此处判断 role === 'assistant' 并添加按钮。

	// Scroll to bottom
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Parses Server-Sent Events (SSE) data from a buffer.
 * Returns an object with parsed events and remaining buffer.
 */
function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}
