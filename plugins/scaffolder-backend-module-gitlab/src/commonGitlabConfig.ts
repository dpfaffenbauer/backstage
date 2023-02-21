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

import { Schema } from 'jsonschema';

export const addCommonGitlabInputProperties = (schema: Schema): Schema => ({
  ...schema,
  required: [
    ...(Array.isArray(schema.required) ? schema.required : []),
    'repoUrl',
  ],
  properties: {
    ...schema.properties,
    repoUrl: {
      title: 'Repository Location',
      type: 'string',
    },
    token: {
      title: 'Authentication Token',
      type: 'string',
      description: 'The token to use for authorization to GitLab',
    },
  },
});

/**
 * Common input properties used for all gitlab actions
 *
 * @public
 */
export type CommonGitlabConfig = {
  token?: string | null | undefined;
  repoUrl: string;
};
