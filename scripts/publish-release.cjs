/**
 * Sussurro - Publicador Automático de Release
 * Garante que a release gerada pelo electron-builder seja tirada de 'draft'
 * e marcada como 'Latest', permitindo que o auto-updater detecte a nova versão.
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;
  const targetTag = 'v' + version;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (!token) {
    console.warn('[PublishRelease] Nenhum GITHUB_TOKEN configurado no ambiente. Pulando finalização.');
    return;
  }

  const owner = 'Hardiscore';
  const repo = 'Sussuro';
  const url = `https://api.github.com/repos/${owner}/${repo}/releases`;

  console.log(`[PublishRelease] Buscando releases para versão ${version} (${targetTag})...`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Sussurro-Release-Agent'
    }
  });

  if (!res.ok) {
    console.warn(`[PublishRelease] Erro ao listar releases: ${res.status} ${await res.text()}`);
    return;
  }

  const releases = await res.json();
  const targetRelease = releases.find(r => 
    r.tag_name === targetTag || 
    r.tag_name === version || 
    r.name === version || 
    r.name === targetTag
  );

  if (!targetRelease) {
    console.log(`[PublishRelease] Release ${targetTag} não encontrada na listagem.`);
    return;
  }

  console.log(`[PublishRelease] Release encontrada: ID=${targetRelease.id}, Tag=${targetRelease.tag_name}, Draft=${targetRelease.draft}`);

  // Verifica se há arquivos na pasta release/ que não foram anexados aos assets (ex: .exe, latest.yml)
  const releaseDir = path.join(__dirname, '..', 'release');
  if (fs.existsSync(releaseDir)) {
    const files = fs.readdirSync(releaseDir);
    for (const file of files) {
      if (file.endsWith('.exe') || file === 'latest.yml' || file.endsWith('.blockmap')) {
        const filePath = path.join(releaseDir, file);
        const existingAsset = Array.isArray(targetRelease.assets) && targetRelease.assets.find(a => a.name === file);
        if (!existingAsset) {
          console.log(`[PublishRelease] Enviando asset pendente ${file} (${fs.statSync(filePath).size} bytes)...`);
          try {
            const fileBuffer = fs.readFileSync(filePath);
            const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${targetRelease.id}/assets?name=${encodeURIComponent(file)}`;
            const uploadRes = await fetch(uploadUrl, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': file === 'latest.yml' ? 'text/yaml' : 'application/octet-stream',
                'Content-Length': fileBuffer.length.toString(),
                'User-Agent': 'Sussurro-Release-Agent'
              },
              body: fileBuffer
            });
            if (uploadRes.ok) {
              console.log(`[PublishRelease] SUCESSO: Arquivo ${file} anexado à Release!`);
            } else {
              console.warn(`[PublishRelease] Falha ao enviar ${file}: ${uploadRes.status} ${await uploadRes.text()}`);
            }
          } catch (uploadErr) {
            console.warn(`[PublishRelease] Erro no upload de ${file}:`, uploadErr);
          }
        } else {
          console.log(`[PublishRelease] Arquivo ${file} já consta na release.`);
        }
      }
    }
  }

  if (targetRelease.draft) {
    console.log(`[PublishRelease] Publicando a Release (removendo estado Draft e tornando Latest)...`);
    const patchRes = await fetch(`${url}/${targetRelease.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Sussurro-Release-Agent'
      },
      body: JSON.stringify({
        draft: false,
        make_latest: 'true'
      })
    });

    if (patchRes.ok) {
      console.log(`[PublishRelease] SUCESSO! A versão ${version} foi publicada e marcada como Latest no GitHub!`);
    } else {
      console.warn(`[PublishRelease] Falha ao publicar release: ${patchRes.status} ${await patchRes.text()}`);
    }
  } else {
    console.log(`[PublishRelease] A release ${targetRelease.tag_name} já é pública e ativa.`);
  }
}

main().catch(err => {
  console.error('[PublishRelease] Erro:', err);
  process.exit(1);
});
