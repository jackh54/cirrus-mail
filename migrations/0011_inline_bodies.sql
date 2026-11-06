-- Small message bodies are also stored inline, as the same {html,text} JSON kept in R2 under body_key, so opening
-- a thread needs no R2 get. NULL means "read R2". Only SELECT * / m.* reads of a single message or one thread
-- pull it; list queries never select it.
ALTER TABLE messages ADD COLUMN body_inline TEXT;
