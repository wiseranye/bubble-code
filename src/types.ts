export type Role = 'system' | 'user' | 'assistant';

export type Message = {
	id: number;
	role: Role;
	content: string;
};
