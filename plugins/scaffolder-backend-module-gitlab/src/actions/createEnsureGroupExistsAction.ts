/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { ScmIntegrationRegistry } from '@backstage/integration';
import { Gitlab } from '@gitbeaker/node';
import { GroupSchema } from '@gitbeaker/core/dist/types/resources/Groups';
import {
  addCommonGitlabInputProperties,
  CommonGitlabConfig,
} from '../commonGitlabConfig';
import { getToken } from '../util';

/**
 * Creates an `gitlab:ensure-group-exists` Scaffolder action.
 *
 * @public
 */
export const createEnsureGroupExistsAction = (options: {
  integrations: ScmIntegrationRegistry;
}) => {
  const { integrations } = options;

  return createTemplateAction<
    CommonGitlabConfig & {
      path: string[];
    }
  >({
    id: 'gitlab:ensure-group-exists',
    description: 'Ensures a Gitlab group exists',
    schema: {
      input: addCommonGitlabInputProperties({
        type: 'object',
        required: ['path'],
        properties: {
          path: {
            title: 'Group path',
            description: 'A path of group names that is ensured to exist',
            type: 'array',
            items: {
              type: 'string',
              minItems: 1,
            },
          },
        },
      }),
      output: {
        type: 'object',
        properties: {
          groupId: {
            title: 'The id of the innermost sub-group',
            type: 'string',
          },
        },
      },
    },
    async handler(ctx) {
      const { path } = ctx.input;
      const { token, integrationConfig } = getToken(ctx.input, integrations);

      const api = new Gitlab({
        host: integrationConfig.config.baseUrl,
        token: token,
      });

      let currentPath: string = 'repos';
      let parent: GroupSchema | null = null;
      for (const pathElement of path) {
        const fullPath = `${currentPath}/${pathElement}`;
        const result = (await api.Groups.search(
          fullPath,
        )) as any as Array<GroupSchema>;
        const subGroup = result.find(
          searchPathElem => searchPathElem.full_path === fullPath,
        );
        if (!subGroup) {
          ctx.logger.info(`creating missing group ${fullPath}`);
          parent = await api.Groups.create(
            pathElement,
            pathElement,
            parent
              ? {
                  parent_id: parent.id,
                }
              : {},
          );
        } else {
          parent = subGroup;
        }
        currentPath = fullPath;
      }
      if (parent !== null) {
        ctx.output('groupId', parent?.id);
      }
    },
  });
};
