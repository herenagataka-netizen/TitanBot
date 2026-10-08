import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

async function fetchAvatar(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('Avatar must be a valid URL.');
    }
    if (url.protocol !== 'https:') throw new Error('Avatar must be an https:// URL.');

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Avatar download failed (HTTP ${res.status}).`);
    if (!(res.headers.get('content-type') || '').startsWith('image/')) {
        throw new Error('Avatar URL must point to an image.');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_AVATAR_BYTES) throw new Error('Avatar must be under 8 MB.');
    return buf;
}

function botCanManageWebhooks(channel, guild) {
    return Boolean(channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageWebhooks));
}

export default {
    data: new SlashCommandBuilder()
        .setName('webhook')
        .setDescription('Create, list, and delete webhooks with custom names and avatars')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks)
        .addSubcommand(sub => sub
            .setName('create')
            .setDescription('Create a webhook with a name and avatar image')
            .addStringOption(o => o.setName('name').setDescription('Webhook display name').setRequired(true).setMinLength(1).setMaxLength(80))
            .addChannelOption(o => o.setName('channel').setDescription('Target channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
            .addStringOption(o => o.setName('avatar').setDescription('https link to an image')))
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List webhooks in a channel')
            .addChannelOption(o => o.setName('channel').setDescription('Channel to inspect').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
        .addSubcommand(sub => sub
            .setName('delete')
            .setDescription('Delete a webhook by ID')
            .addStringOption(o => o.setName('webhook_id').setDescription('Webhook ID (see /webhook list)').setRequired(true))),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const sub = interaction.options.getSubcommand();
        const { guild, member } = interaction;

        try {
            if (sub === 'create') {
                const name = interaction.options.getString('name', true).trim();
                const channel = interaction.options.getChannel('channel', true);
                const avatarUrl = interaction.options.getString('avatar');

                if (!botCanManageWebhooks(channel, guild)) {
                    return interaction.editReply({ embeds: [createEmbed({ title: 'Missing Permission', description: `I need **Manage Webhooks** in ${channel}.`, color: 'error' })] });
                }
                if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageWebhooks)) {
                    return interaction.editReply({ embeds: [createEmbed({ title: 'Missing Permission', description: `You need **Manage Webhooks** in ${channel}.`, color: 'error' })] });
                }

                const avatar = avatarUrl ? await fetchAvatar(avatarUrl) : undefined;
                const webhook = await channel.createWebhook({
                    name,
                    avatar,
                    reason: `Created by ${interaction.user.tag} via /webhook create`,
                });

                logger.info('Webhook created', { guildId: guild.id, channelId: channel.id, webhookId: webhook.id, userId: interaction.user.id });

                // The URL contains a secret token: only send it in this ephemeral reply.
                return interaction.editReply({
                    embeds: [createEmbed({ title: 'Webhook Created', description: `**${name}** in ${channel}`, color: 'success' })
                        .addFields(
                            { name: 'Webhook ID', value: webhook.id, inline: true },
                            { name: 'URL (keep private)', value: `\`${webhook.url}\`` },
                        )],
                });
            }

            if (sub === 'list') {
                const channel = interaction.options.getChannel('channel', true);
                if (!botCanManageWebhooks(channel, guild)) {
                    return interaction.editReply({ embeds: [createEmbed({ title: 'Missing Permission', description: `I need **Manage Webhooks** in ${channel}.`, color: 'error' })] });
                }
                const hooks = await channel.fetchWebhooks();
                const lines = hooks.map(w => `• **${w.name}**: \`${w.id}\``);
                return interaction.editReply({
                    embeds: [createEmbed({ title: `Webhooks in #${channel.name}`, description: lines.length ? lines.join('\n') : 'No webhooks found.' })],
                });
            }

            if (sub === 'delete') {
                if (!member.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
                    return interaction.editReply({ embeds: [createEmbed({ title: 'Missing Permission', description: 'You need **Manage Webhooks** to delete webhooks.', color: 'error' })] });
                }
                const id = interaction.options.getString('webhook_id', true).trim();
                const hooks = await guild.fetchWebhooks();
                const hook = hooks.get(id);
                if (!hook) {
                    return interaction.editReply({ embeds: [createEmbed({ title: 'Not Found', description: 'No webhook with that ID exists in this server.', color: 'error' })] });
                }
                await hook.delete(`Deleted by ${interaction.user.tag} via /webhook delete`);
                logger.info('Webhook deleted', { guildId: guild.id, webhookId: id, userId: interaction.user.id });
                return interaction.editReply({ embeds: [createEmbed({ title: 'Webhook Deleted', description: `Removed **${hook.name}**.`, color: 'success' })] });
            }
        } catch (error) {
            logger.error('Webhook command error:', error);
            return interaction.editReply({
                embeds: [createEmbed({
                    title: 'Error',
                    description: error.message?.startsWith('Avatar') ? error.message : 'Could not complete the webhook action.',
                    color: 'error',
                })],
            }).catch(() => {});
        }
    },
};
