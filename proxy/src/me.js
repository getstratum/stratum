export async function meRoute(request, reply) {
  const { user, team, policy } = request.ctx

  // Fetch pricing for the models this user is allowed to use
  let models = []
  if (policy?.allowed_models?.length) {
    const { rows } = await this.db.query(
      `SELECT provider, model_id, display_name,
              cost_per_1k_input_tokens, cost_per_1k_output_tokens
       FROM ai_models
       WHERE model_id = ANY($1) AND is_active = true
       ORDER BY provider, display_name`,
      [policy.allowed_models]
    )
    models = rows
  }

  return {
    user:   { id: user.id, email: user.email, name: user.name },
    team:   team   ? { id: team.id,   name: team.name   } : null,
    policy: policy ? { id: policy.id, name: policy.name } : null,
    models,
  }
}
